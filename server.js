const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;
const ALLOWED_EXTENSIONS = ['.txt', '.json', '.md', '.js', '.html', '.css', '.xml', '.log'];

// Security configurations
const SECURITY_CONFIG = {
  maxFilenameLength: 255,
  allowedChars: /^[a-zA-Z0-9._-]+$/,
  blockedPaths: ['..', '/', '\\', ':'],
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
};

// In-memory stores (use Redis/database in production)
const rateLimitStore = new Map();
const sessionStore = new Map();
const auditLog = [];

// Ensure 'files' folder exists with proper permissions
const filesDir = path.join(__dirname, 'files');
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir, { mode: 0o755 });
}

// Utility functions
const generateSessionId = () => crypto.randomBytes(32).toString('hex');

const logActivity = (action, filename, ip, success = true, error = null) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    filename,
    ip,
    success,
    error: error?.message || null,
    userAgent: null
  };
  auditLog.push(logEntry);
  
  // Keep only last 1000 entries
  if (auditLog.length > 1000) {
    auditLog.shift();
  }
  
  console.log(`[${logEntry.timestamp}] ${ip} - ${action} ${filename} - ${success ? 'SUCCESS' : 'FAILED'}`);
};

const sanitizeFilename = (filename) => {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename');
  }
  
  // Remove path traversal attempts
  filename = filename.replace(/\.\./g, '').replace(/[\/\\:]/g, '');
  
  // Check length
  if (filename.length > SECURITY_CONFIG.maxFilenameLength) {
    throw new Error('Filename too long');
  }
  
  // Check allowed characters
  if (!SECURITY_CONFIG.allowedChars.test(filename)) {
    throw new Error('Filename contains invalid characters');
  }
  
  return filename;
};

const validateFileExtension = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`File extension ${ext} not allowed`);
  }
};

const checkRateLimit = (ip) => {
  const now = Date.now();
  const clientData = rateLimitStore.get(ip) || { requests: [], lastReset: now };
  
  // Remove old requests outside the window
  clientData.requests = clientData.requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (clientData.requests.length >= RATE_LIMIT_MAX_REQUESTS) {
    throw new Error('Rate limit exceeded');
  }
  
  clientData.requests.push(now);
  rateLimitStore.set(ip, clientData);
};

const getClientIP = (req) => {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         '127.0.0.1';
};

const validateSession = (req) => {
  // For this demo, we'll skip session validation but log the attempt
  // In production, implement proper session management
  return true;
};

const getFileStats = (filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory()
    };
  } catch (err) {
    return null;
  }
};

const getSystemInfo = () => {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cpuUsage: process.cpuUsage()
  };
};

// Enhanced file operations
const createFileSecure = (filename, content = 'Hello from FileMe!', ip) => {
  return new Promise((resolve, reject) => {
    try {
      const sanitizedName = sanitizeFilename(filename);
      validateFileExtension(sanitizedName);
      
      const filePath = path.join(filesDir, sanitizedName);
      
      // Check if file already exists
      if (fs.existsSync(filePath)) {
        throw new Error('File already exists');
      }
      
      // Check content size
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
        throw new Error('File content too large');
      }
      
      fs.writeFile(filePath, content, { mode: 0o644 }, (err) => {
        if (err) {
          logActivity('CREATE', sanitizedName, ip, false, err);
          reject(err);
        } else {
          logActivity('CREATE', sanitizedName, ip, true);
          resolve(`File "${sanitizedName}" created successfully!`);
        }
      });
    } catch (err) {
      logActivity('CREATE', filename, ip, false, err);
      reject(err);
    }
  });
};

const readFileSecure = (filename, ip) => {
  return new Promise((resolve, reject) => {
    try {
      const sanitizedName = sanitizeFilename(filename);
      const filePath = path.join(filesDir, sanitizedName);
      
      // Check if file exists and is readable
      fs.access(filePath, fs.constants.R_OK, (err) => {
        if (err) {
          logActivity('READ', sanitizedName, ip, false, err);
          reject(new Error('File not found or not readable'));
          return;
        }
        
        const stats = getFileStats(filePath);
        if (stats && stats.size > MAX_FILE_SIZE) {
          logActivity('READ', sanitizedName, ip, false, new Error('File too large'));
          reject(new Error('File too large to read'));
          return;
        }
        
        fs.readFile(filePath, 'utf-8', (err, data) => {
          if (err) {
            logActivity('READ', sanitizedName, ip, false, err);
            reject(err);
          } else {
            logActivity('READ', sanitizedName, ip, true);
            resolve({
              content: data,
              stats: stats
            });
          }
        });
      });
    } catch (err) {
      logActivity('READ', filename, ip, false, err);
      reject(err);
    }
  });
};

const deleteFileSecure = (filename, ip) => {
  return new Promise((resolve, reject) => {
    try {
      const sanitizedName = sanitizeFilename(filename);
      const filePath = path.join(filesDir, sanitizedName);
      
      fs.unlink(filePath, (err) => {
        if (err) {
          logActivity('DELETE', sanitizedName, ip, false, err);
          reject(new Error('File not found or already deleted'));
        } else {
          logActivity('DELETE', sanitizedName, ip, true);
          resolve(`File "${sanitizedName}" deleted successfully!`);
        }
      });
    } catch (err) {
      logActivity('DELETE', filename, ip, false, err);
      reject(err);
    }
  });
};

const listFilesSecure = (ip) => {
  return new Promise((resolve, reject) => {
    fs.readdir(filesDir, (err, files) => {
      if (err) {
        logActivity('LIST', 'directory', ip, false, err);
        reject(err);
        return;
      }
      
      const fileList = files
        .filter(file => ALLOWED_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        .map(file => {
          const filePath = path.join(filesDir, file);
          const stats = getFileStats(filePath);
          return {
            name: file,
            size: stats ? stats.size : 0,
            modified: stats ? stats.modified : null,
            extension: path.extname(file)
          };
        })
        .sort((a, b) => b.modified - a.modified);
      
      logActivity('LIST', 'directory', ip, true);
      resolve(fileList);
    });
  });
};

// HTTP Server
const server = http.createServer(async (req, res) => {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;
  const query = querystring.parse(parsedUrl.query);
  
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  
  try {
    // Rate limiting
    checkRateLimit(clientIP);
    
    // CORS handling
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(200);
      res.end();
      return;
    }
    
    // Serve the main page
    if (pathname === '/' && req.method === 'GET') {
      fs.readFile('./index.html', (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error loading page');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        }
      });
      return;
    }
    
    // Handle POST requests for file content
    if ((pathname === '/create' || pathname === '/update') && req.method === 'POST') {
      let body = '';
      let bodySize = 0;
      
      req.on('data', chunk => {
        bodySize += chunk.length;
        if (bodySize > MAX_FILE_SIZE) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Request entity too large');
          return;
        }
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const result = await createFileSecure(data.filename, data.content, clientIP);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(result);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(err.message);
        }
      });
      return;
    }
    
    // Create a file (GET - simple version)
    if (pathname === '/create' && req.method === 'GET') {
      try {
        const filename = query.name;
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Filename required');
          return;
        }
        
        const result = await createFileSecure(filename, undefined, clientIP);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(result);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    }
    
    // Read a file
    else if (pathname === '/read' && req.method === 'GET') {
      try {
        const filename = query.name;
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Filename required');
          return;
        }
        
        const result = await readFileSecure(filename, clientIP);
        
        if (query.format === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result, null, 2));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(result.content);
        }
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    }
    
    // Delete a file
    else if (pathname === '/delete' && req.method === 'GET') {
      try {
        const filename = query.name;
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Filename required');
          return;
        }
        
        const result = await deleteFileSecure(filename, clientIP);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(result);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    }
    
    // List files
    else if (pathname === '/list' && req.method === 'GET') {
      try {
        const files = await listFilesSecure(clientIP);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    }
    
    // System info (admin endpoint)
    else if (pathname === '/admin/system' && req.method === 'GET') {
      const systemInfo = getSystemInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(systemInfo, null, 2));
    }
    
    // Audit logs (admin endpoint)
    else if (pathname === '/admin/logs' && req.method === 'GET') {
      const limit = parseInt(query.limit) || 50;
      const logs = auditLog.slice(-limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs, null, 2));
    }
    
    // Health check
    else if (pathname === '/health' && req.method === 'GET') {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        filesCount: fs.readdirSync(filesDir).length
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    }
    
    // File download with proper headers
    else if (pathname === '/download' && req.method === 'GET') {
      try {
        const filename = query.name;
        if (!filename) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Filename required');
          return;
        }
        
        const sanitizedName = sanitizeFilename(filename);
        const filePath = path.join(filesDir, sanitizedName);
        
        fs.access(filePath, fs.constants.R_OK, (err) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
          }
          
          const stats = fs.statSync(filePath);
          res.setHeader('Content-Disposition', `attachment; filename="${sanitizedName}"`);
          res.setHeader('Content-Length', stats.size);
          res.setHeader('Content-Type', 'application/octet-stream');
          
          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
          
          logActivity('DOWNLOAD', sanitizedName, clientIP, true);
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(err.message);
      }
    }
    
    // Not found
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
    
  } catch (err) {
    if (err.message === 'Rate limit exceeded') {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too many requests. Please try again later.');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(PORT, () => {
  console.log(`🚀 Enhanced FileMe Server running at http://localhost:${PORT}`);
  console.log(`📁 Files directory: ${filesDir}`);
  console.log(`🔒 Security features: Rate limiting, Input validation, Audit logging`);
  console.log(`📊 Admin endpoints: /admin/system, /admin/logs, /health`);
});

module.exports = server;