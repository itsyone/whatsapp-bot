#!/bin/bash
FILE="/root/wa-bot-live/node_modules/@itsliaaa/baileys/lib/Utils/messages.js"
echo "Applying newsletter watermark patch..."
# Remove newsletter block (lines vary after updates, use pattern match)
node -e "
const fs = require('fs');
let code = fs.readFileSync('$FILE', 'utf8');
// Remove newsletter object from mediaAnnotation array
code = code.replace(/,\s*newsletter:\s*\{[^}]*\}/gs, '');
// Remove forwardedNewsletterMessageInfo assignments
code = code.replace(/contextInfo\.forwardedNewsletterMessageInfo\s*=\s*\{[^}]*\};/gs, '');
fs.writeFileSync('$FILE', code);
console.log('Patch applied successfully');
"
