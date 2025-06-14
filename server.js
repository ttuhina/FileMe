const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const PORT = 3000;

// Ensure 'files' folder exists
const filesDir = path.join(__dirname, 'files');
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir);
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;
  const query = querystring.parse(parsedUrl.query);

  if (pathname === '/' && req.method === 'GET') {
    // Serve the index.html file
    fs.readFile('./index.html', (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading page');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  }

  // Create a file
  else if (pathname === '/create' && req.method === 'GET') {
    const filename = query.name || 'newfile.txt';
    const filePath = path.join(filesDir, filename);
    fs.writeFile(filePath, 'Hello from FileMe!', (err) => {
      if (err) {
        res.writeHead(500);
        res.end('Failed to create file');
      } else {
        res.writeHead(200);
        res.end(`File "${filename}" created!`);
      }
    });
  }

  // Read a file
  else if (pathname === '/read' && req.method === 'GET') {
    const filename = query.name;
    if (!filename) {
      res.writeHead(400);
      res.end('Filename required');
      return;
    }

    const filePath = path.join(filesDir, filename);
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(data);
      }
    });
  }

  // Delete a file
  else if (pathname === '/delete' && req.method === 'GET') {
    const filename = query.name;
    if (!filename) {
      res.writeHead(400);
      res.end('Filename required');
      return;
    }

    const filePath = path.join(filesDir, filename);
    fs.unlink(filePath, (err) => {
      if (err) {
        res.writeHead(404);
        res.end('File not found or already deleted');
      } else {
        res.writeHead(200);
        res.end(`File "${filename}" deleted`);
      }
    });
  }

  // Not found
  else {
    res.writeHead(404);
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
