import express from 'express';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8443);
const host = process.env.HOST || '0.0.0.0';
const videoRoot = path.resolve(process.env.VIDEO_DIR || path.join(__dirname, 'videos'));
const certPath = process.env.HTTPS_CERT || path.join(__dirname, 'certs', 'server.pem');
const keyPath = process.env.HTTPS_KEY || path.join(__dirname, 'certs', 'server-key.pem');

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/videos', async (_req, res, next) => {
  try {
    await fs.promises.mkdir(videoRoot, { recursive: true });
    const videos = [];
    await scan(videoRoot, '', videos);
    videos.sort((a, b) => {
      const folderOrder = Number(!a.folder) - Number(!b.folder);
      if (folderOrder !== 0) return folderOrder;
      const folderNameOrder = a.folder.localeCompare(b.folder, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (folderNameOrder !== 0) return folderNameOrder;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    res.json({ videos });
  } catch (error) {
    next(error);
  }
});

app.get('/ca.crt', (_req, res, next) => {
  if (!fs.existsSync(path.join(__dirname, 'certs', 'rootCA.pem'))) {
    return res
      .status(404)
      .type('text/plain')
      .send('CA certificate not found. Run npm run setup:cert first.');
  }
  res.download(path.join(__dirname, 'certs', 'rootCA.pem'), 'rvrp-local-ca.crt', (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get('/videos/:id', async (req, res, next) => {
  const relative = decodeId(req.params.id);
  if (!relative || !relative.toLowerCase().endsWith('.mp4')) {
    return res.status(400).json({ error: 'Invalid video id.' });
  }
  try {
    const realRoot = await fs.promises.realpath(videoRoot);
    const filename = path.resolve(realRoot, ...relative.split(/[\\/]/));
    if (!isInside(realRoot, filename)) return res.status(400).json({ error: 'Invalid video id.' });
    const realFilename = await fs.promises.realpath(filename);
    if (!isInside(realRoot, realFilename))
      return res.status(400).json({ error: 'Invalid video id.' });
    const stat = await fs.promises.stat(realFilename);
    if (!stat.isFile()) return res.status(404).json({ error: 'Video not found.' });
    res.type('video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(realFilename, { acceptRanges: true }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return res.status(404).json({ error: 'Video not found.' });
    }
    next(error);
  }
});

app.use(
  '/vendor',
  express.static(path.join(__dirname, 'node_modules', 'three', 'build'), {
    fallthrough: false,
    immutable: true,
    maxAge: '1y',
  }),
);
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (!res.headersSent)
    res.status(500).json({ error: 'The server could not complete that request.' });
});

async function scan(directory, relative, videos) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    // Do not follow symlinks: the library must remain inside VIDEO_DIR.
    if (entry.isSymbolicLink()) continue;
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(childPath, childRelative, videos);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
      const stat = await fs.promises.stat(childPath);
      const normalized = childRelative.split(path.sep).join('/');
      videos.push({
        id: Buffer.from(normalized).toString('base64url'),
        name: entry.name.replace(/\.mp4$/i, ''),
        folder: path.dirname(normalized) === '.' ? '' : path.dirname(normalized),
        size: stat.size,
      });
    }
  }
}

function decodeId(value) {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (!decoded || Buffer.from(decoded).toString('base64url') !== value) return null;
    if (decoded.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..'))
      return null;
    return decoded;
  } catch {
    return null;
  }
}

function isInside(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function networkAddresses() {
  const addresses = new Set(
    (process.env.CERT_HOSTS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  try {
    const saved = fs.readFileSync(path.join(__dirname, 'certs', 'hosts.txt'), 'utf8');
    for (const value of saved
      .split(/\r?\n/)
      .map((host) => host.trim())
      .filter(Boolean))
      addresses.add(value);
  } catch {
    // Local certificate setup has not saved any names yet.
  }
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === 'IPv4' && !item.internal) addresses.add(item.address);
      }
    }
  } catch {
    console.warn(
      'Could not enumerate network interfaces; use the computer LAN IP to open the player.',
    );
  }
  return [...addresses].filter(
    (value) => value !== 'localhost' && value !== '127.0.0.1' && value !== '::1',
  );
}

const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);

await fs.promises.mkdir(videoRoot, { recursive: true });
server.listen(port, host, () => {
  const protocol = useHttps ? 'https' : 'http';
  const addresses = networkAddresses();
  console.log(`RVRP listening on ${protocol}://localhost:${port}`);
  for (const address of addresses) console.log(`  Network: ${protocol}://${address}:${port}`);
  console.log(`Video directory: ${videoRoot}`);
  if (!useHttps) {
    console.warn(
      'HTTPS certificate not found. The library works over HTTP, but WebXR requires trusted HTTPS.',
    );
    console.warn(
      'Run npm run setup:cert, trust the local CA on the headset, then restart the server.',
    );
  }
});
