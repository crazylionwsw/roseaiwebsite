/**
 * Vector Database Indexer
 *
 * Reads documents from gdrive-docs/ (synced from Google Drive),
 * chunks them, generates embeddings via DeepSeek, and pushes
 * to a vector database (Upstash Vector / Cloudflare Vectorize).
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-xxx \
 *   VECTOR_DB_URL=https://xxx.upstash.io \
 *   VECTOR_DB_TOKEN=xxx \
 *   node index-vectorize.mjs
 *
 * Supported vector DB backends:
 *   - upstash   (default) — Upstash Vector (REST API)
 *   - local     — local knowledge-base.json (original approach)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { resolve, extname } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS_DIR = resolve(ROOT, 'gdrive-docs');
const OUTPUT = resolve(ROOT, 'api', 'knowledge-base.json');
const CHUNK_SIZE = 500;        // max chars per chunk
const CHUNK_OVERLAP = 80;      // overlap between chunks
const EMBED_BATCH = 16;        // batch size for embedding API (avoid rate limits)

// ---- Utility: Split document into chunks ----
function chunkDocument(text, source) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);

  let current = '';
  let sourceLines = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Track source line number (approximate)
    const approxLines = trimmed.split('\n').length;

    if ((current + '\n\n' + trimmed).length > CHUNK_SIZE && current.length > 0) {
      chunks.push({
        id: source + '#chunk-' + chunks.length,
        text: current.trim(),
        source: source,
        metadata: { lines: sourceLines.length },
      });
      // Keep last paragraph for overlap
      const words = current.split(/\s+/);
      const overlapText = words.slice(-Math.floor(CHUNK_OVERLAP / 5)).join(' ');
      current = overlapText + '\n\n' + trimmed;
      sourceLines = [approxLines];
    } else {
      if (current.length > 0) current += '\n\n';
      current += trimmed;
      sourceLines.push(approxLines);
    }
  }

  if (current.trim().length > 20) {
    chunks.push({
      id: source + '#chunk-' + chunks.length,
      text: current.trim(),
      source: source,
      metadata: { lines: sourceLines.length },
    });
  }

  return chunks;
}

// ---- Utility: Extract text from all doc files ----
function loadDocuments() {
  if (!existsSync(DOCS_DIR)) {
    console.warn('Warning: ' + DOCS_DIR + ' not found. Run sync-gdrive.mjs first.');
    return [];
  }

  const files = readdirSync(DOCS_DIR).filter((f) =>
    /\.(md|txt|mdx)$/i.test(f)
  );

  if (files.length === 0) {
    console.warn('Warning: No .md or .txt files found in ' + DOCS_DIR);
    return [];
  }

  const docs = [];
  for (const file of files) {
    const content = readFileSync(resolve(DOCS_DIR, file), 'utf-8');
    docs.push({ name: file, content });
    console.log('  Loaded: ' + file + ' (' + content.length + ' chars)');
  }
  return docs;
}

// ---- Generate embeddings via DeepSeek API ----
async function generateEmbeddings(texts, apiKey) {
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch('https://api.deepseek.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-embedding',
        input: batch,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error('Embedding API error: ' + res.status + ' ' + err);
    }

    const data = await res.json();
    for (const item of data.data) {
      allEmbeddings[item.index + i] = item.embedding;
    }

    console.log('  Embedded ' + Math.min(i + EMBED_BATCH, texts.length) + '/' + texts.length);
  }

  return allEmbeddings;
}

// ---- Push to Upstash Vector ----
async function pushToUpstash(chunks, embeddings) {
  const url = process.env.VECTOR_DB_URL;
  const token = process.env.VECTOR_DB_TOKEN;

  if (!url || !token) {
    throw new Error('VECTOR_DB_URL and VECTOR_DB_TOKEN required for upstash backend');
  }

  const apiUrl = url.replace(/\/$/, '');

  // Upsert in batches
  const batchSize = 16;
  let indexed = 0;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const vectors = [];
    for (let j = i; j < Math.min(i + batchSize, chunks.length); j++) {
      vectors.push({
        id: chunks[j].id,
        vector: embeddings[j],
        metadata: {
          text: chunks[j].text.substring(0, 1000),
          source: chunks[j].source,
        },
      });
    }

    const res = await fetch(apiUrl + '/upsert', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(vectors),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error('Upstash upsert error: ' + res.status + ' ' + err);
    }

    indexed += vectors.length;
    console.log('  Indexed ' + indexed + '/' + chunks.length);
  }
}

// ---- Push to local JSON (fallback) ----
function pushToLocal(chunks, embeddings) {
  const data = chunks.map((c, i) => ({
    ...c,
    embedding: embeddings[i],
  }));

  mkdirSync(resolve(ROOT, 'api'), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify({ chunks: data }, null, 2));
  console.log('  Written to ' + OUTPUT);
}

// ---- Main ----
async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY');

  const backend = process.env.VECTOR_DB_BACKEND || 'upstash';
  console.log('Vector DB backend: ' + backend);

  // 1. Load documents
  console.log('\n1. Loading documents from ' + DOCS_DIR);
  const docs = loadDocuments();
  if (docs.length === 0) {
    console.log('No documents to index. Exiting.');
    return;
  }

  // 2. Chunk documents
  console.log('\n2. Chunking documents...');
  const allChunks = [];
  for (const doc of docs) {
    const chunks = chunkDocument(doc.content, doc.name);
    allChunks.push(...chunks);
  }
  console.log('  Created ' + allChunks.length + ' chunks');

  // 3. Generate embeddings
  console.log('\n3. Generating embeddings via DeepSeek...');
  const texts = allChunks.map((c) => c.text);
  const embeddings = await generateEmbeddings(texts, apiKey);

  // 4. Push to backend
  console.log('\n4. Pushing to vector DB (' + backend + ')...');
  if (backend === 'upstash') {
    await pushToUpstash(allChunks, embeddings);
  } else {
    pushToLocal(allChunks, embeddings);
  }

  console.log('\n✓ Done! Indexed ' + allChunks.length + ' chunks.');
}

main().catch((err) => {
  console.error('\n✗ Failed:', err.message);
  process.exit(1);
});
