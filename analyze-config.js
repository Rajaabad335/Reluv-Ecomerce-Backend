const fs = require('fs');
const path = require('path');

console.log("=== Checking Strapi Configuration ===\n");

// Read .env file manually (without using dotenv)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const lines = envContent.split('\n');
  
  console.log("=== Environment Variables ===");
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      if (trimmed.includes('DATABASE') || trimmed.includes('STRAPI')) {
        console.log(trimmed);
      }
    }
  });
}

// Check database.ts for default values
console.log("\n=== Database Configuration Defaults ===");
const dbConfig = fs.readFileSync(path.join(__dirname, 'config', 'database.ts'), 'utf8');
console.log("Default client:", dbConfig.includes('postgres') ? "postgres" : "sqlite");
console.log("Default DB name:", dbConfig.includes("'strapi'") ? "strapi" : "unknown");
