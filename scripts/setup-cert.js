import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certDir = path.join(root, 'certs');
const cert = path.join(certDir, 'server.pem');
const key = path.join(certDir, 'server-key.pem');
const caCert = path.join(certDir, 'rootCA.pem');
const caKey = path.join(certDir, 'rootCA-key.pem');
const csr = path.join(certDir, 'server.csr');
const extensions = path.join(certDir, 'server.ext');
const hostsFile = path.join(certDir, 'hosts.txt');
const addresses = new Set(['localhost', '127.0.0.1']);
for (const host of (process.env.CERT_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean))
  addresses.add(host);
try {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.add(item.address);
    }
  }
} catch {
  console.warn(
    'Could not enumerate network interfaces; include the headset connection address in CERT_HOSTS.',
  );
}

function openssl(args) {
  const result = spawnSync('openssl', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('OpenSSL failed. Confirm that openssl is installed and available on PATH.');
    process.exit(result.status || 1);
  }
}

const probe = spawnSync('openssl', ['version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.error('OpenSSL is required. Install OpenSSL, then run npm run setup:cert again.');
  process.exit(1);
}

await mkdir(certDir, { recursive: true });
const dnsNames = [...addresses].filter((value) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(value));
const ipAddresses = [...addresses].filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value));
const sans = [
  ...dnsNames.map((value, index) => `DNS.${index + 1} = ${value}`),
  ...ipAddresses.map((value, index) => `IP.${index + 1} = ${value}`),
];

if (!(await exists(caCert)) || !(await exists(caKey))) {
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-sha256',
    '-days',
    '3650',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caCert,
    '-subj',
    '/CN=RVRP Local Video Player CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
}

await writeFile(
  extensions,
  `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=@alt_names\n\n[alt_names]\n${sans.join('\n')}\n`,
);
await chmod(caKey, 0o600);
openssl([
  'req',
  '-new',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  key,
  '-out',
  csr,
  '-subj',
  '/CN=RVRP Video Player',
]);
await chmod(key, 0o600);
openssl([
  'x509',
  '-req',
  '-in',
  csr,
  '-CA',
  caCert,
  '-CAkey',
  caKey,
  '-CAcreateserial',
  '-out',
  cert,
  '-days',
  '365',
  '-sha256',
  '-extfile',
  extensions,
]);
await writeFile(hostsFile, `${[...addresses].join('\n')}\n`);

console.log('\nCreated a local CA and HTTPS certificate for:');
for (const address of addresses) console.log(`  ${address}`);
console.log(`\nInstall ${caCert} as a trusted CA certificate on the PC browser and VR headset.`);
console.log(
  'Keep certs/rootCA-key.pem private. Restart the player, then open its printed HTTPS address.',
);
if (addresses.size === 2)
  console.log(
    'Only localhost addresses were found. Add the computer LAN IP with CERT_HOSTS=192.168.x.x npm run setup:cert, then restart the server.',
  );

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}
