const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const coreFile = path.join(rootDir, 'finance-core.js');
const targetFiles = [
  path.join(rootDir, 'index (PWA).html'),
  path.join(rootDir, 'index.html'),
  path.join(rootDir, 'app', 'src', 'main', 'assets', 'index.html')
];

const startMarker = '// === FINANCE-CORE START ===';
const endMarker = '// === FINANCE-CORE END ===';

function syncCore() {
  if (!fs.existsSync(coreFile)) {
    console.error(`Error: Canonical core file missing at ${coreFile}`);
    process.exit(1);
  }

  const coreContent = fs.readFileSync(coreFile, 'utf8');
  const coreMatch = coreContent.match(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`));
  if (!coreMatch) {
    console.error(`Error: Markers ${startMarker} ... ${endMarker} not found in ${coreFile}`);
    process.exit(1);
  }

  const canonicalBlock = coreMatch[0];
  console.log(`Syncing finance-core (${canonicalBlock.length} bytes)...`);

  let hasError = false;

  targetFiles.forEach(targetPath => {
    if (!fs.existsSync(targetPath)) {
      console.warn(`Target file does not exist (skipping): ${targetPath}`);
      return;
    }

    let fileContent = fs.readFileSync(targetPath, 'utf8');
    const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);

    if (regex.test(fileContent)) {
      fileContent = fileContent.replace(regex, canonicalBlock);
      fs.writeFileSync(targetPath, fileContent, 'utf8');
      console.log(`✓ Updated ${path.relative(rootDir, targetPath)}`);
    } else {
      console.warn(`! Markers not found in ${path.relative(rootDir, targetPath)} - Insertion needed`);
    }
  });

  console.log('Finance core sync complete.');
}

syncCore();
