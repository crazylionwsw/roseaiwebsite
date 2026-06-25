/**
 * Google Drive Sync Script
 *
 * Downloads knowledge base documents from a Google Drive folder.
 *
 * Setup:
 *   1. Create a Google Cloud Project → Enable Google Drive API
 *   2. Create a Service Account → download JSON key
 *   3. Share your knowledge base folder with the service account email
 *   4. Set env: GOOGLE_SERVICE_ACCOUNT_JSON (base64 of the key JSON)
 *   5. Set env: GOOGLE_DRIVE_FOLDER_ID
 *
 * Usage:
 *   GOOGLE_SERVICE_ACCOUNT_JSON=... GOOGLE_DRIVE_FOLDER_ID=xxx node sync-gdrive.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

// Use simpler REST API approach instead of heavy googleapis package
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = resolve(ROOT, 'gdrive-docs');

async function getAccessToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const key = JSON.parse(
    raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  );

  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: 'RS256', typ: 'JWT' };
  const jwtClaim = {
    iss: key.client_email,
    scope: SCOPES.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  // Simple JWT signing using Web Crypto
  const headerB64 = btoa(JSON.stringify(jwtHeader));
  const claimB64 = btoa(JSON.stringify(jwtClaim));
  const signatureInput = headerB64 + '.' + claimB64;

  const pem = key.private_key;
  const pemBody = pem.replace(/-----.*-----|\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signatureInput)
  );

  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const jwt = signatureInput + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('OAuth failed: ' + res.status + ' ' + err);
  }

  const data = await res.json();
  return data.access_token;
}

async function listFiles(accessToken, folderId) {
  const allFiles = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and (mimeType contains 'text/' or mimeType = 'application/pdf' or name contains '.md' or name contains '.txt') and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime),nextPageToken',
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error('Drive API list error: ' + res.status + ' ' + err);
    }

    const data = await res.json();
    for (const f of data.files || []) allFiles.push(f);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allFiles;
}

async function downloadFile(accessToken, fileId, mimeType) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Download error for ' + fileId + ': ' + res.status);
  }

  if (mimeType === 'application/pdf') {
    const buf = await res.arrayBuffer();
    const tmp = '/tmp/roseai-pdf-' + fileId + '.pdf';
    writeFileSync(tmp, Buffer.from(buf));
    const text = execSync('pdftotext -layout "' + tmp + '" -', { encoding: 'utf-8' });
    execSync('rm -f "' + tmp + '"');
    return text;
  }

  return await res.text();
}



function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_\-. ]/g, '_');
}

async function sync() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('Missing GOOGLE_DRIVE_FOLDER_ID');

  console.log('Authenticating with Google Drive...');
  const token = await getAccessToken();

  console.log('Listing files in folder:', folderId);
  const files = await listFiles(token, folderId);
  console.log('Found ' + files.length + ' files');

  mkdirSync(OUTPUT, { recursive: true });

  let count = 0;
  for (const file of files) {
    try {
      const ext = file.name.endsWith('.md') ? '.md'
        : file.name.endsWith('.txt') ? '.txt'
        : file.mimeType === 'application/pdf' ? '.txt'
        : '.md';

      const localName = sanitizeName(file.name.replace(/\.[^.]+$/, '')) + ext;
      const localPath = resolve(OUTPUT, localName);

      console.log('  Downloading: ' + file.name);
      const content = await downloadFile(token, file.id, file.mimeType);
      writeFileSync(localPath, content, 'utf-8');
      count++;
    } catch (err) {
      console.error('  Failed: ' + file.name + ' — ' + err.message);
    }
  }

  console.log('Done. Downloaded ' + count + '/' + files.length + ' files to ' + OUTPUT);
}

sync().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
