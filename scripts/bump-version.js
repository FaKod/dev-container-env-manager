const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const versionParts = packageJson.version.split('.');
if (versionParts.length !== 3) {
  console.error('Invalid version format in package.json. Expected x.y.z');
  process.exit(1);
}

// Increment patch version
versionParts[2] = parseInt(versionParts[2], 10) + 1;
const newVersion = versionParts.join('.');

packageJson.version = newVersion;

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`Version bumped to ${newVersion}`);
