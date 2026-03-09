const { google } = require('googleapis');
const { getAuthClient } = require('./sheets');
const { google: googleConfig } = require('./config');

function getDocsClient() {
  return google.docs({ version: 'v1', auth: getAuthClient() });
}

/**
 * Get the end index of the document body (i.e. the highest endIndex across all elements).
 */
async function getDocEndIndex(docs) {
  const doc = await docs.documents.get({ documentId: googleConfig.outputDocId });
  const content = doc.data.body.content || [];
  let endIndex = 1;
  for (const el of content) {
    if (el.endIndex != null && el.endIndex > endIndex) {
      endIndex = el.endIndex;
    }
  }
  return endIndex;
}

/**
 * Bootstrap write: clear the document and write fresh content.
 * An empty Google Doc has endIndex = 1 (just the trailing newline paragraph).
 */
async function writeBootstrapDocument(content) {
  const docs = getDocsClient();
  const endIndex = await getDocEndIndex(docs);

  const requests = [];

  // Delete all existing content (keep only the trailing newline at endIndex - 1)
  if (endIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 },
      },
    });
  }

  // Insert new content at the beginning
  requests.push({
    insertText: {
      location: { index: 1 },
      text: content,
    },
  });

  await docs.documents.batchUpdate({
    documentId: googleConfig.outputDocId,
    requestBody: { requests },
  });
}

/**
 * Incremental append: insert content at the end of the document.
 * Adds two newlines before the new content to separate it from existing content.
 */
async function appendToDocument(content) {
  const docs = getDocsClient();
  const endIndex = await getDocEndIndex(docs);

  // Insert before the trailing newline (endIndex - 1)
  await docs.documents.batchUpdate({
    documentId: googleConfig.outputDocId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: endIndex - 1 },
            text: '\n\n' + content,
          },
        },
      ],
    },
  });
}

module.exports = { writeBootstrapDocument, appendToDocument };
