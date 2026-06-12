// ═════════════════════════════════════════════════════════════════
// TIMEROI Model Sync — Online Neural Network Update System
// ═════════════════════════════════════════════════════════════════
//
// Periodically fetches updated model weights and community
// classifications from a GitHub-hosted JSON endpoint.
// All users get the latest trained model automatically.
//
// Flow:
//   1. On startup, fetch latest weights from GitHub raw URL
//   2. Hot-reload the neural net with new weights
//   3. Fetch community classification DB and merge locally
//   4. Every 30 min, check for new versions
//   5. When user classifies an app, queue it for upload
//   5. Batch-upload user contributions via GitHub API
//
// ═════════════════════════════════════════════════════════════════

const https = require('https');
const http = require('http');

// ─────────────────────────────────────────────
// CONFIGURATION
// Change this repo to your own GitHub repo
// ─────────────────────────────────────────────

const SYNC_CONFIG = {
  // GitHub raw URLs for model weights and community DB
  weightsUrl: 'https://raw.githubusercontent.com/Chingolem/MnaagmentAPP/main/weights.json',
  classificationsUrl: 'https://raw.githubusercontent.com/Chingolem/MnaagmentAPP/main/classifications.json',
  versionUrl: 'https://raw.githubusercontent.com/Chingolem/MnaagmentAPP/main/version.json',

  // How often to check for updates (ms)
  checkIntervalMs: 30 * 60 * 1000, // 30 minutes

  // Upload endpoint (GitHub API for creating files via PUT)
  // Uses a personal access token stored in userData
  uploadRepo: 'Chingolem/MnaagmentAPP',
  uploadBranch: 'main',
};

// ─────────────────────────────────────────────
// HTTP HELPER — simple GET with timeout
// ─────────────────────────────────────────────

function fetchJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Invalid JSON from ' + url));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// MODEL SYNC ENGINE
// ─────────────────────────────────────────────

class ModelSync {
  constructor() {
    this.currentVersion = 0;
    this.lastCheckTime = 0;
    this.syncInterval = null;
    this.pendingClassifications = [];
    this.isSyncing = false;

    // Callbacks — set by main.js
    this.onWeightsUpdate = null;    // (weightsData) => void
    this.onClassificationsUpdate = null; // (classifications) => void
    this.onNewVersion = null;       // (version) => void
  }

  // Start periodic sync
  start() {
    // Initial check
    this.checkForUpdates();

    // Periodic check
    this.syncInterval = setInterval(() => {
      this.checkForUpdates();
    }, SYNC_CONFIG.checkIntervalMs);

    console.log('[ModelSync] Started. Checking every', SYNC_CONFIG.checkIntervalMs / 60000, 'minutes');
  }

  stop() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  // Check GitHub for new model version
  async checkForUpdates() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      // 1. Check version
      let versionData;
      try {
        versionData = await fetchJSON(SYNC_CONFIG.versionUrl, 8000);
      } catch (err) {
        // Version endpoint might not exist yet — that's okay
        console.log('[ModelSync] Version check skipped (endpoint not available)');
        this.isSyncing = false;
        return;
      }

      const remoteVersion = versionData.version || 0;

      if (remoteVersion <= this.currentVersion) {
        console.log('[ModelSync] Already up to date (v' + this.currentVersion + ')');
        this.isSyncing = false;
        return;
      }

      console.log('[ModelSync] New version available: v' + remoteVersion + ' (current: v' + this.currentVersion + ')');

      // 2. Fetch new weights
      try {
        const weightsData = await fetchJSON(SYNC_CONFIG.weightsUrl, 30000);
        if (weightsData && this.onWeightsUpdate) {
          this.onWeightsUpdate(weightsData);
          console.log('[ModelSync] ✅ Neural net weights updated to v' + remoteVersion);
        }
      } catch (err) {
        console.error('[ModelSync] Failed to fetch weights:', err.message);
      }

      // 3. Fetch community classifications
      try {
        const classData = await fetchJSON(SYNC_CONFIG.classificationsUrl, 10000);
        if (classData && classData.classifications && this.onClassificationsUpdate) {
          this.onClassificationsUpdate(classData.classifications);
          console.log('[ModelSync] ✅ Community classifications merged (' + Object.keys(classData.classifications).length + ' rules)');
        }
      } catch (err) {
        console.error('[ModelSync] Failed to fetch classifications:', err.message);
      }

      // Update local version
      this.currentVersion = remoteVersion;
      this.lastCheckTime = Date.now();

      if (this.onNewVersion) {
        this.onNewVersion(remoteVersion);
      }

    } catch (err) {
      console.error('[ModelSync] Update check failed:', err.message);
    } finally {
      this.isSyncing = false;
    }
  }

  // Queue a user classification for community upload
  queueClassification(process, classification) {
    this.pendingClassifications.push({
      process,
      classification,
      timestamp: Date.now()
    });
  }

  // Upload queued classifications to GitHub
  // This requires a GitHub token with repo write access
  async uploadClassifications(token) {
    if (this.pendingClassifications.length === 0) return;

    const payload = {
      classifications: this.pendingClassifications.map(c => ({
        process: c.process,
        classification: c.classification,
        timestamp: c.timestamp
      }))
    };

    try {
      // For now, we use a simple approach: write to a contributions file
      // In production, you'd use GitHub API with the token
      const url = `https://api.github.com/repos/${SYNC_CONFIG.uploadRepo}/contents/contributions.json`;

      // Get current file SHA (required for update)
      let sha = null;
      try {
        const current = await fetchJSON(url + '?ref=' + SYNC_CONFIG.uploadBranch, 8000);
        sha = current.sha;
      } catch (e) {
        // File might not exist yet
      }

      const content = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');

      const postData = JSON.stringify({
        message: `contrib: ${this.pendingClassifications.length} classifications from desktop agent`,
        content: content,
        branch: SYNC_CONFIG.uploadBranch,
        ...(sha ? { sha } : {})
      });

      // POST to GitHub API
      await new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'PUT',
          headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'TIMEROI-Desktop-Agent',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('[ModelSync] ✅ Uploaded', payload.classifications.length, 'classifications to community DB');
              this.pendingClassifications = [];
              resolve();
            } else {
              reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });

    } catch (err) {
      console.error('[ModelSync] Upload failed:', err.message);
    }
  }

  // Get sync status for UI display
  getStatus() {
    return {
      version: this.currentVersion,
      lastCheck: this.lastCheckTime,
      pendingUploads: this.pendingClassifications.length,
      isOnline: this.lastCheckTime > 0
    };
  }
}

module.exports = { ModelSync, SYNC_CONFIG };
