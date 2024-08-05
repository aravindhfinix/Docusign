const express = require('express');
const docusign = require('docusign-esign');
const fs = require('fs');
const prompt = require('prompt-sync')();
const app = express();
const port = 4000;

const jwtConfig = {
  integrationId: 'a171db04-8aad-40ee-8574-df29291f31f5',
  userKeyId: '3f627a02-f0e2-447e-81f7-6015819137bc',
  privateKeyLocation: './private.key',
  dsOauthServer: 'https://account-d.docusign.com'
};
const SCOPES = ['signature', 'impersonation'];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route to send the local design file for signature
app.post('/send', async (req, res) => {
  const filePath = './World_Wide_Corp_lorem.pdf'; // Path to your local file
  const userEmail = req.body.userEmail;
  const userId = req.body.userId;

  if (!userEmail) {
    return res.status(400).send('User email is required.');
  }

  try {
    // Authenticate and get the access token and account ID
    const authData = await authenticate();
    const envelopeId = await sendDocumentForSignature(filePath, userEmail, userId, authData);
    const recipientViewUrl = await createRecipientView(envelopeId, userEmail, userId, authData);
    res.status(200).json({ message: 'Document sent successfully for signature', envelopeId: envelopeId, recipientViewUrl: recipientViewUrl });
  } catch (error) {
    console.error('Error in /send route:', error);
    res.status(500).send('Error sending document for signature.');
  }
});

// Route to get details of an envelope by envelope ID
app.get('/envelopes/:envelopeId', async (req, res) => {
  const envelopeId = req.params.envelopeId;

  if (!envelopeId) {
    return res.status(400).send('Envelope ID is required.');
  }

  try {
    // Authenticate and get the access token and account ID
    const authData = await authenticate();
    const envelopeDetails = await getEnvelopeDetails(envelopeId, authData);
    res.status(200).json(envelopeDetails);
  } catch (error) {
    console.error('Error in /envelopes/:envelopeId route:', error);
    res.status(500).send('Error retrieving envelope details.');
  }
});

// Function to authenticate using JWT
async function authenticate() {
  const jwtLifeSec = 10 * 60; // requested lifetime for the JWT is 10 min
  const dsApi = new docusign.ApiClient();
  dsApi.setOAuthBasePath(jwtConfig.dsOauthServer.replace('https://', '')); // it should be domain only.
  let rsaKey = fs.readFileSync(jwtConfig.privateKeyLocation);

  try {
    const results = await dsApi.requestJWTUserToken(jwtConfig.integrationId,
      jwtConfig.userKeyId, SCOPES, rsaKey, jwtLifeSec);
    const accessToken = results.body.access_token;

    // get user info
    const userInfoResults = await dsApi.getUserInfo(accessToken);

    // use the default account
    let userInfo = userInfoResults.accounts.find(account => account.isDefault === 'true');

    return {
      accessToken: results.body.access_token,
      apiAccountId: userInfo.accountId,
      basePath: `${userInfo.baseUri}/restapi`
    };
  } catch (e) {
    console.error('Error in authentication:', e);
    // Determine the source of the error
    if (e.response.data.error === 'consent_required') {
      if (getConsent()) { return authenticate(); }
    } else {
      // Consent has been granted. Show status code for DocuSign API error
      console.log(`\nAPI problem: Status code ${e.response.status}, message body:
        ${JSON.stringify(body, null, 4)}\n\n`);
    }
  }
}

// Function to send document for signature using DocuSign
async function sendDocumentForSignature(filePath, userEmail, userId, authData) {
  const apiClient = new docusign.ApiClient();
  apiClient.setBasePath(authData.basePath);
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + authData.accessToken);

  const envelopesApi = new docusign.EnvelopesApi(apiClient);

  const envDef = new docusign.EnvelopeDefinition();
  envDef.emailSubject = 'Please sign this document';
  envDef.emailBlurb = 'Hello, please sign this document.';

  const documentBase64 = fs.readFileSync(filePath, 'base64');
  const doc = new docusign.Document();
  doc.documentBase64 = documentBase64;
  doc.name = 'Uploaded Document';
  doc.fileExtension = 'pdf';
  doc.documentId = '1';
  envDef.documents = [doc];

  const signer = new docusign.Signer();
  signer.email = userEmail;
  signer.name = 'User'; // Replace with the recipient's name
  signer.recipientId = '1'; // This must match the recipientId used in the view request
  signer.routingOrder = '1';
  signer.clientUserId = userId; // Ensure this matches the clientUserId used in the view request

  const signHere = new docusign.SignHere();
  signHere.documentId = '1';
  signHere.pageNumber = '1'; // Assuming single-page document, adjust if needed
  signHere.recipientId = '1';
  signHere.tabLabel = 'SignHereTab';
  signHere.xPosition = '100';
  signHere.yPosition = '600'; // Adjust yPosition to be at the end of the page

  signer.tabs = new docusign.Tabs();
  signer.tabs.signHereTabs = [signHere];

  envDef.recipients = new docusign.Recipients();
  envDef.recipients.signers = [signer];
  envDef.status = 'sent'; // Ensure the envelope status is set to 'sent'

  const results = await envelopesApi.createEnvelope(authData.apiAccountId, { envelopeDefinition: envDef });
  console.log('Envelope created:', results);
  return results.envelopeId;
}

// Function to create recipient view URL
async function createRecipientView(envelopeId, userEmail, userId, authData) {
  const apiClient = new docusign.ApiClient();
  apiClient.setBasePath(authData.basePath);
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + authData.accessToken);

  const envelopesApi = new docusign.EnvelopesApi(apiClient);

  const viewRequest = new docusign.RecipientViewRequest();
  viewRequest.returnUrl = 'http://localhost:3000'; // Replace with your return URL
  viewRequest.authenticationMethod = 'email'; // Authentication method
  viewRequest.email = userEmail;
  viewRequest.userName = 'User'; // Replace with the recipient's name
  viewRequest.recipientId = '1'; // This must match the recipientId used in the envelope
  viewRequest.clientUserId = userId; // Unique identifier for the recipient, should be a unique string for each recipient

  try {
    // Create the recipient view
    const recipientView = await envelopesApi.createRecipientView(authData.apiAccountId, envelopeId, { recipientViewRequest: viewRequest });

    // Return or log the view URL
    return recipientView.url;
  } catch (error) {
    console.error('Error creating recipient view:', error);
    throw error;
  }
}

// Function to get envelope details by envelope ID
async function getEnvelopeDetails(envelopeId, authData) {
  const apiClient = new docusign.ApiClient();
  apiClient.setBasePath(authData.basePath);
  apiClient.addDefaultHeader('Authorization', 'Bearer ' + authData.accessToken);

  const envelopesApi = new docusign.EnvelopesApi(apiClient);

  const envelopeDetails = await envelopesApi.getEnvelope(authData.apiAccountId, envelopeId);
  return envelopeDetails;
}

function getConsent() {
  var urlScopes = SCOPES.join('+');

  // Construct consent URL
  var redirectUri = 'http://localhost:4000';
  var consentUrl = `${jwtConfig.dsOauthServer}/oauth/auth?response_type=code&` +
    `scope=${urlScopes}&client_id=${jwtConfig.integrationId}&` +
    `redirect_uri=${redirectUri}`;

  console.log('Open the following URL in your browser to grant consent to the application:');
  console.log(consentUrl);
  console.log('Consent granted? \n 1)Yes \n 2)No');
  let consentGranted = prompt('');
  if (consentGranted === '1') {
    return true;
  } else {
    console.error('Please grant consent!');
    process.exit();
  }
}


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

