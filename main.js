const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const https = require('https');
const { ModelSync } = require('./model-sync');

// Load the neural network — v3 multilingual 512-dim
let MicroNetModule, embedProcessInfoFn, CLASS_NAMES;
try {
  const v3 = require('./micronet-v3');
  MicroNetModule = v3.MicroNet;
  embedProcessInfoFn = v3.embedProcessInfo;
  CLASS_NAMES = v3.CLASS_NAMES;
  console.log('[MicroNet] Using scaled v3 network (VOCAB_SIZE=8192, HIDDEN_SIZE=1024, 5 classes)');
} catch (err) {
  try {
    const lite = require('./micronet');
    MicroNetModule = lite.MicroNet;
    embedProcessInfoFn = lite.embedProcessInfo;
    CLASS_NAMES = lite.CLASS_NAMES;
    console.log('[MicroNet] Using lite network (fallback)');
  } catch (err2) {
    console.error('[MicroNet] No neural network module available:', err2);
  }
}

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let psProcess = null;
let wss = null;
let activeClientWs = null;
let modelSync = null;

// ═══════════════════════════════════════════════════════════
// ENHANCED TRACKING STATE ENGINE
// ═══════════════════════════════════════════════════════════

const TrackingState = {
  UNKNOWN: 'unknown',
  WORKING: 'working',
  GAMING: 'gaming',
  ENTERTAINMENT: 'entertainment',
  IDLE: 'idle',
  BREAK: 'break',
  FOCUSED: 'focused'
};

let currentState = TrackingState.UNKNOWN;
let previousState = TrackingState.UNKNOWN;
let activeClientId = null;
let activeVideoId = null;
let isTracking = false;

// Confidence scoring system — each factor contributes weight
let stateConfidence = { working: 0, gaming: 0, idle: 0 };
let stateHistory = []; // rolling window of recent states
const HISTORY_WINDOW = 10; // keep last 10 ticks for smoothing

// Focus streak tracking
let focusStreakStart = null;
let focusStreakProcess = null;
let totalFocusStreakMs = 0;
let longestFocusStreakMs = 0;
let focusStreakCount = 0;

// Break detection
let consecutiveWorkTicks = 0;
let breakSuggestedAt = 0;
let lastBreakTakenAt = Date.now();
const BREAK_SUGGESTION_INTERVAL = 45 * 60 * 1000; // 45 minutes
const BREAK_SUGGESTION_WORK_TICKS = 1800; // ~18 minutes at 600ms ticks

// Session tracking
let sessionStartTime = Date.now();
let sessionWorkMs = 0;
let sessionGamingMs = 0;
let sessionEntertainmentMs = 0;
let sessionIdleMs = 0;
let lastTickTime = Date.now();

// Process transition tracking (debounce rapid switches)
let currentProcess = '';
let currentTitle = '';
let processStartTime = Date.now();
let processTransitionBuffer = null;
const TRANSITION_DEBOUNCE_MS = 3000; // 3 seconds to confirm a process switch

// Premiere correlation tracking
let lastCreativeAppTime = 0;
let lastYouTubeActiveTime = 0;
let youtubeIdleTriggered = false;

// Overlay dismiss tracking
let overlayDismissedForProcess = null;
let lastOverlayProcess = null;

// App duration accumulator
let appDurations = {};
let appSessionLog = []; // { process, classification, startMs, endMs }

// Daily stats persistence
let dailyStats = {};

function getAppDurationsPath() {
  return path.join(app.getPath('userData'), 'app-durations.json');
}

function getDailyStatsPath() {
  return path.join(app.getPath('userData'), 'daily-stats.json');
}

function loadAppDurations() {
  try {
    const p = getAppDurationsPath();
    if (fs.existsSync(p)) {
      appDurations = JSON.parse(fs.readFileSync(p, 'utf8'));
      console.log('Loaded app durations:', Object.keys(appDurations).length, 'processes');
    }
  } catch (err) {
    console.error('Failed to load app durations:', err);
  }
}

function saveAppDurations() {
  try {
    fs.writeFileSync(getAppDurationsPath(), JSON.stringify(appDurations, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save app durations:', err);
  }
}

function loadDailyStats() {
  try {
    const p = getDailyStatsPath();
    if (fs.existsSync(p)) {
      dailyStats = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load daily stats:', err);
  }
}

function saveDailyStats() {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (!dailyStats[today]) {
      dailyStats[today] = { workMs: 0, gamingMs: 0, entertainmentMs: 0, idleMs: 0, focusStreaks: 0, longestStreakMs: 0 };
    }
    dailyStats[today].workMs = sessionWorkMs;
    dailyStats[today].gamingMs = sessionGamingMs;
    dailyStats[today].entertainmentMs = sessionEntertainmentMs;
    dailyStats[today].idleMs = sessionIdleMs;
    dailyStats[today].focusStreaks = focusStreakCount;
    dailyStats[today].longestStreakMs = longestFocusStreakMs;

    // Keep only last 30 days
    const keys = Object.keys(dailyStats).sort();
    if (keys.length > 30) {
      keys.slice(0, keys.length - 30).forEach(k => delete dailyStats[k]);
    }

    fs.writeFileSync(getDailyStatsPath(), JSON.stringify(dailyStats, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save daily stats:', err);
  }
}

// ═══════════════════════════════════════════════════════════
// CONFIGURATION SYSTEM
// ═══════════════════════════════════════════════════════════

let config = {
  workKeywords: [
    'envato', 'motionarray', 'artlist', 'shutterstock', 'behance', 'soundstripe',
    'fiverr', 'upwork', 'editing', 'assets', 'fonts', 'stock', 'github', 'supabase',
    'vercel', 'localhost', 'managment', 'figma', 'canva', 'notion', 'linear',
    'jira', 'trello', 'asana', 'slack', 'teams', 'zoom', 'docs.google',
    'drive.google', 'stackoverflow', 'npmjs', 'webpack', 'vite', 'nextjs',
    'tailwind', 'typescript', 'docker', 'kubernetes', 'aws', 'azure', 'gcp'
  ],
  gameKeywords: [
    'tl', 'throneandliberty', 'throne_and_liberty', 'steam', 'valorant',
    'leagueoflegends', 'dota2', 'valheim', 'csgo', 'minecraft', 'wow',
    'warmane', 'diablo', 'cyberpunk', 'witcher', 'gta5', 'fortnite',
    'epicgames', 'r5apex', 'pubg', 'overwatch', 'genshinimpact', 'roblox',
    'eaapp', 'ubisoft', 'battle.net', 'rockstar', 'paradox', 'ffxiv',
    'eso', 'baldursgate', 'hogwarts', 'starfield', 'spiderman', 'godofwar',
    'sims', 'simulator', 'sim ', 'truck'
  ],
  idleThresholdMs: 120000,
  autoTrackingEnabled: true,
  gamingTrackingEnabled: true,
  autoStartOnBoot: true,
  startMinimized: true,
  notificationsEnabled: true,
  breakRemindersEnabled: true,
  modelSharingEnabled: true,
  onlineSearchEnabled: true,
  githubToken: '',
  focusGoalMinutes: 120, // daily focus goal in minutes
  processClassifications: {
    'discord': 'ai',
    'chrome': 'ai',
    'msedge': 'ai',
    'firefox': 'ai',
    'brave': 'ai',
    'opera': 'ai',
    'premiere': 'work',
    'resolve': 'work',
    'photoshop': 'work',
    'aftereffects': 'work',
    'illustrator': 'work',
    'indesign': 'work',
    'audition': 'work',
    'lightroom': 'work',
    'capcut': 'work',
    'vegas': 'work',
    'audacity': 'work',
    'blender': 'work',
    'cinema4d': 'work',
    'unreal': 'work',
    'unity': 'work',
    'obs': 'work',
    'code': 'work',
    'vscode': 'work',
    'cursor': 'work',
    'webstorm': 'work',
    'xcode': 'work',
    'androidstudio': 'work',
    'devenv': 'work',
    'figma': 'work',
    'notion': 'work',
    'slack': 'work',
    'teams': 'work',
    'spotify': 'ignore',
    'telegram': 'ai',
    'whatsapp': 'ai',
    'zoom': 'work'
  }
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p, 'utf8');
      const loaded = JSON.parse(data);
      config = { ...config, ...loaded };

      // Migrate browser classifications to dynamic 'ai' Decide mode
      if (config.processClassifications) {
        const resetToAI = ['chrome', 'msedge', 'discord', 'brave', 'firefox', 'opera', 'telegram', 'whatsapp'];
        resetToAI.forEach(proc => {
          if (config.processClassifications[proc] === 'work' || config.processClassifications[proc] === 'both') {
            config.processClassifications[proc] = 'ai';
          }
        });
      }

      // Automatically add new simulator game keywords to existing settings
      if (config.gameKeywords) {
        const required = ['sims', 'simulator', 'sim ', 'truck'];
        let updated = false;
        required.forEach(kw => {
          if (!config.gameKeywords.includes(kw)) {
            config.gameKeywords.push(kw);
            updated = true;
          }
        });
        if (updated) {
          saveConfig();
        }
      }

      console.log('Loaded config from:', p);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// ═══════════════════════════════════════════════════════════
// ACTIVITY LOGS
// ═══════════════════════════════════════════════════════════

let activityLogs = [];

function addLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const logEntry = { time, message, type, timestamp: Date.now() };
  activityLogs.unshift(logEntry);
  if (activityLogs.length > 200) activityLogs.pop();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-update', logEntry);
  }
}

// ═══════════════════════════════════════════════════════════
// IN-APP TOAST NOTIFICATION SYSTEM
// Solid, visible toasts rendered inside the app window
// ═══════════════════════════════════════════════════════════

function sendNativeNotification(title, body, type = 'info') {
  if (!config.notificationsEnabled) return;
  // Send as in-app toast — renderer handles the visual
  sendToRenderer('show-toast', { title, body, type, timestamp: Date.now() });
}


// ═══════════════════════════════════════════════════════════
// MICRO-AI ENGINE — Behavioral Pattern Recognition
// Lightweight local AI that understands WHAT program you use
// and WHY based on context, timing, co-occurrence, and history.
// No external API — all logic runs locally with <1ms per tick.
// ═══════════════════════════════════════════════════════════

const MicroAI = {
  // The lightweight neural network
  net: null,

  // Behavioral history: tracks which processes follow which,
  // how long you use them, at what times, and with what co-occurring apps.
  behaviorProfile: {},

  // Co-occurrence map: if app A is used right after app B, they're correlated
  transitionGraph: {},

  // Time-of-day patterns: [process → { morning: count, afternoon: count, evening: count, night: count }]
  timePatterns: {},

  // Session context: what "session type" we're currently in
  currentSessionType: null,
  sessionConfidence: 0,

  // Learning rate
  getProfilePath() {
    return path.join(app.getPath('userData'), 'micro-ai-profile.json');
  },

  getNetPath() {
    return path.join(app.getPath('userData'), 'micronet-weights.json');
  },

  load() {
    try {
      const p = this.getProfilePath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        this.behaviorProfile = data.behaviorProfile || {};
        this.transitionGraph = data.transitionGraph || {};
        this.timePatterns = data.timePatterns || {};
        console.log('[MicroAI] Loaded profile:', Object.keys(this.behaviorProfile).length, 'processes');
      }
    } catch (err) {
      console.error('[MicroAI] Load error:', err);
    }

    // Load neural network weights
    try {
      const np = this.getNetPath();
      if (fs.existsSync(np)) {
        const netData = JSON.parse(fs.readFileSync(np, 'utf8'));
        // Use the right class based on what loaded
        if (netData.version === 3 && MicroNetModule) {
          this.net = MicroNetModule.deserialize(netData);
        } else if (netData.version === 2 && MicroNetModule && MicroNetModule.name === 'MicroNetExtended') {
          const extended = require('./micronet-extended');
          this.net = extended.MicroNetExtended.deserialize(netData);
        } else if (MicroNetModule) {
          const lite = require('./micronet');
          this.net = lite.MicroNet.deserialize(netData);
        }
        console.log('[MicroAI] Loaded MicroNet weights — trained', this.net.trained, 'times');
      } else {
        if (MicroNetModule) {
          this.net = new MicroNetModule();
          console.log('[MicroAI] Initialized fresh MicroNet (pre-trained with domain knowledge)');
        }
      }
    } catch (err) {
      console.error('[MicroAI] Net load error, creating fresh:', err);
      if (MicroNetModule) this.net = new MicroNetModule();
    }
  },

  save() {
    try {
      const data = {
        behaviorProfile: this.behaviorProfile,
        transitionGraph: this.transitionGraph,
        timePatterns: this.timePatterns
      };
      fs.writeFileSync(this.getProfilePath(), JSON.stringify(data), 'utf8');
    } catch (err) {
      console.error('[MicroAI] Save error:', err);
    }

    // Save neural net weights
    try {
      fs.writeFileSync(this.getNetPath(), JSON.stringify(this.net.serialize()), 'utf8');
    } catch (err) {
      console.error('[MicroAI] Net save error:', err);
    }
  },

  // Record a process usage event for learning
  recordUsage(process, title, classification, durationSec) {
    if (!process || classification === 'ignore') return;

    const proc = process.toLowerCase();
    const hour = new Date().getHours();
    const timeSlot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

    // Train the neural net on this observation (lightweight online learning)
    if (this.net && classification !== 'unclassified') {
      try {
        this.net.learn(proc, title || '', classification, 0.01);
      } catch (err) {
        // Silent — never let net training crash the tracker
      }
    }

    // Update behavior profile
    if (!this.behaviorProfile[proc]) {
      this.behaviorProfile[proc] = {
        totalSessions: 0,
        totalDurationSec: 0,
        avgDurationSec: 0,
        classifications: {},
        lastTitle: '',
        commonTitles: {},
        lastUsed: 0
      };
    }

    const profile = this.behaviorProfile[proc];
    profile.totalSessions++;
    profile.totalDurationSec += durationSec;
    profile.avgDurationSec = profile.totalDurationSec / profile.totalSessions;
    profile.classifications[classification] = (profile.classifications[classification] || 0) + 1;
    profile.lastUsed = Date.now();

    // Track common window titles (sampled — only keep top 10)
    const titKey = (title || '').substring(0, 80);
    if (titKey) {
      profile.commonTitles[titKey] = (profile.commonTitles[titKey] || 0) + 1;
      const keys = Object.keys(profile.commonTitles);
      if (keys.length > 10) {
        let minKey = keys[0], minVal = profile.commonTitles[keys[0]];
        keys.forEach(k => { if (profile.commonTitles[k] < minVal) { minVal = profile.commonTitles[k]; minKey = k; } });
        delete profile.commonTitles[minKey];
      }
    }

    // Time-of-day patterns
    if (!this.timePatterns[proc]) this.timePatterns[proc] = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    this.timePatterns[proc][timeSlot]++;
  },

  // Record a process transition (A → B)
  recordTransition(fromProcess, toProcess) {
    if (!fromProcess || !toProcess || fromProcess === toProcess) return;
    const from = fromProcess.toLowerCase();
    if (!this.transitionGraph[from]) this.transitionGraph[from] = {};
    this.transitionGraph[from][toProcess.toLowerCase()] = (this.transitionGraph[from][toProcess.toLowerCase()] || 0) + 1;
  },

  // Infer WHY a process is being used based on context
  inferWhy(process, title, classification) {
    const proc = (process || '').toLowerCase();
    const tit = (title || '').toLowerCase();
    const profile = this.behaviorProfile[proc];
    const reasons = [];

    // 1. Historical pattern: what has this app been classified as most?
    if (profile && profile.classifications) {
      const dominant = Object.entries(profile.classifications).sort((a, b) => b[1] - a[1])[0];
      if (dominant) {
        const ratio = dominant[1] / profile.totalSessions;
        if (ratio > 0.7) {
          reasons.push({ weight: 0.4, text: `You've used ${proc} as ${dominant[0]} ${Math.round(ratio * 100)}% of the time (${dominant[1]} sessions)` });
        }
      }
    }

    // 2. Session duration pattern
    if (profile && profile.avgDurationSec > 0) {
      if (profile.avgDurationSec > 1800) {
        reasons.push({ weight: 0.3, text: `Typical ${proc} sessions last ${Math.floor(profile.avgDurationSec / 60)}m — suggests deep focus` });
      } else if (profile.avgDurationSec < 120) {
        reasons.push({ weight: 0.2, text: `Brief ${proc} usage pattern (~${Math.floor(profile.avgDurationSec)}s avg) — likely quick task` });
      }
    }

    // 3. Co-occurrence: what app did you come FROM?
    // Check recent transitions to this process
    let topTransition = null;
    Object.keys(this.transitionGraph).forEach(from => {
      if (this.transitionGraph[from][proc]) {
        const count = this.transitionGraph[from][proc];
        if (!topTransition || count > topTransition.count) {
          topTransition = { from, count };
        }
      }
    });

    if (topTransition) {
      const fromClass = config.processClassifications[topTransition.from] || 'unknown';
      if (fromClass === 'work' || CreativeApps.some(a => topTransition.from.includes(a))) {
        reasons.push({ weight: 0.35, text: `Often opened after ${topTransition.from} (work context) — ${topTransition.count} times` });
      } else if (fromClass === 'gaming' || config.gameKeywords.some(kw => topTransition.from.includes(kw))) {
        reasons.push({ weight: 0.3, text: `Often opened after ${topTransition.from} (gaming context) — ${topTransition.count} times` });
      }
    }

    // 4. Time-of-day inference
    const timePattern = this.timePatterns[proc];
    if (timePattern) {
      const hour = new Date().getHours();
      const currentSlot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const totalUses = Object.values(timePattern).reduce((a, b) => a + b, 0);
      if (totalUses >= 3) {
        const slotRatio = timePattern[currentSlot] / totalUses;
        if (slotRatio > 0.5) {
          reasons.push({ weight: 0.2, text: `You typically use ${proc} during the ${currentSlot} (${Math.round(slotRatio * 100)}% of usage)` });
        }
      }
    }

    // 5. Title context analysis
    if (tit) {
      // Check for project/file names that indicate active work
      const projectExtensions = ['.prproj', '.aep', '.psd', '.ai', '.indd', '.cdr', '.fla', '.blend', '.unity', '.cpp', '.js', '.ts', '.py', '.java'];
      if (projectExtensions.some(ext => tit.includes(ext))) {
        reasons.push({ weight: 0.5, text: 'Active project file detected in window title — indicates active work' });
      }

      // Communication patterns
      const commsKeywords = ['meeting', 'call', 'standup', 'review', 'demo', 'call with', 'sync with'];
      if (commsKeywords.some(kw => tit.includes(kw))) {
        reasons.push({ weight: 0.4, text: 'Meeting/call context detected — work communication' });
      }

      // Learning patterns
      const learnKeywords = ['course', 'tutorial', 'learn', 'class', 'lecture', 'study', 'documentation', 'docs'];
      if (learnKeywords.some(kw => tit.includes(kw))) {
        reasons.push({ weight: 0.35, text: 'Learning/educational context detected' });
      }

      // Shopping / personal
      const personalKeywords = ['amazon', 'ebay', 'aliexpress', 'shop', 'cart', 'checkout', 'banking', 'paypal'];
      if (personalKeywords.some(kw => tit.includes(kw))) {
        reasons.push({ weight: 0.4, text: 'Personal/shopping context detected — non-work activity' });
      }

      // Social media
      const socialKeywords = ['twitter', 'reddit', 'instagram', 'tiktok', 'facebook', 'feed', 'timeline'];
      if (socialKeywords.some(kw => tit.includes(kw))) {
        reasons.push({ weight: 0.4, text: 'Social media browsing detected — likely distraction' });
      }
    }

    // 6. Correlation with active tracking
    if (isTracking) {
      reasons.push({ weight: 0.45, text: 'Timer is running — activity is part of a tracked work session' });
    }

    // Sort by weight and compose the explanation
    reasons.sort((a, b) => b.weight - a.weight);

    const overallConfidence = reasons.length > 0
      ? Math.min(1.0, reasons.reduce((sum, r) => sum + r.weight, 0) / 1.5)
      : 0.1;

    return {
      reasons: reasons.slice(0, 3), // Top 3 reasons
      confidence: overallConfidence,
      summary: reasons.length > 0
        ? reasons[0].text
        : `No historical pattern for ${proc} yet — still learning`
    };
  },

  // Smart auto-classify: Neural net is the primary classifier,
  // behavioral patterns boost confidence and provide reasoning.
  smartClassify(process, title) {
    const proc = (process || '').toLowerCase();
    const tit = (title || '').toLowerCase();
    const profile = this.behaviorProfile[proc];

    // ── NEURAL NET CLASSIFICATION (primary) ──
    // Runs the 2-layer neural network on n-gram embeddings
    let nnResult = null;
    try {
      nnResult = this.net.classify(proc, tit);
    } catch (err) {
      console.error('[MicroAI] Net inference error:', err);
    }

    // If the net is confident enough, use its prediction directly
    if (nnResult && nnResult.confidence > 0.55) {
      let nnClass = nnResult.className;

      // Map 'ai-decide' from the net to a context-aware decision
      if (nnClass === 'ai-decide') {
        // Use behavioral patterns to resolve ai-decide
        nnClass = this._resolveAIDecide(proc, tit, profile);
      }

      // Boost confidence with behavioral patterns
      let boostedConf = nnResult.confidence;
      let reason = `Neural net classified as ${nnClass} (${(nnResult.confidence * 100).toFixed(0)}% confidence)`;

      if (profile && profile.totalSessions >= 3) {
        const dominant = Object.entries(profile.classifications).sort((a, b) => b[1] - a[1])[0];
        if (dominant && dominant[0] === nnClass) {
          boostedConf = Math.min(1.0, boostedConf + 0.15);
          reason += ` — confirmed by ${dominant[1]} past sessions`;
        }
      }

      return {
        classification: nnClass,
        confidence: boostedConf,
        source: 'micro-ai-neural',
        reason
      };
    }

    // ── BEHAVIORAL PATTERN FALLBACK ──
    // If the net isn't confident, fall back to learned patterns

    // If we have enough history, use the dominant classification
    if (profile && profile.totalSessions >= 3) {
      const dominant = Object.entries(profile.classifications).sort((a, b) => b[1] - a[1])[0];
      if (dominant && (dominant[1] / profile.totalSessions) > 0.65) {
        // If the net agrees, boost confidence significantly
        let netAgrees = nnResult && nnResult.className === dominant[0];
        let confidence = 0.5 + (dominant[1] / profile.totalSessions) * 0.4;
        if (netAgrees) confidence = Math.min(1.0, confidence + 0.2);

        return {
          classification: dominant[0],
          confidence,
          source: netAgrees ? 'micro-ai-neural-confirmed' : 'micro-ai-learned',
          reason: netAgrees
            ? `Neural net + ${dominant[1]} sessions agree: ${dominant[0]}`
            : `Learned from ${dominant[1]}/${profile.totalSessions} past sessions as ${dominant[0]}`
        };
      }
    }

    // Transition context: if you came from a work app, this might be work too
    let topTransition = null;
    Object.keys(this.transitionGraph).forEach(from => {
      if (this.transitionGraph[from][proc]) {
        const count = this.transitionGraph[from][proc];
        if (!topTransition || count > topTransition.count) {
          topTransition = { from, count };
        }
      }
    });

    if (topTransition && topTransition.count >= 2) {
      const fromClass = config.processClassifications[topTransition.from];
      if (fromClass === 'work') {
        return {
          classification: 'work',
          confidence: 0.55,
          source: 'micro-ai-transition',
          reason: `Usually opened after work app ${topTransition.from} (${topTransition.count} times)`
        };
      } else if (fromClass === 'gaming') {
        return {
          classification: 'gaming',
          confidence: 0.50,
          source: 'micro-ai-transition',
          reason: `Usually opened after gaming app ${topTransition.from} (${topTransition.count} times)`
        };
      }
    }

    // If the net has any signal at all (even weak), use it
    if (nnResult && nnResult.confidence > 0.35) {
      let nnClass = nnResult.className;
      if (nnClass === 'ai-decide') nnClass = this._resolveAIDecide(proc, tit, profile);
      return {
        classification: nnClass,
        confidence: nnResult.confidence,
        source: 'micro-ai-neural-weak',
        reason: `Neural net suggests ${nnClass} (low confidence: ${(nnResult.confidence * 100).toFixed(0)}%)`
      };
    }

    // Time-of-day heuristic
    const timePattern = this.timePatterns[proc];
    if (timePattern) {
      const hour = new Date().getHours();
      const currentSlot = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const totalUses = Object.values(timePattern).reduce((a, b) => a + b, 0);
      if (totalUses >= 3) {
        if (currentSlot === 'night' || currentSlot === 'evening') {
          const nightRatio = (timePattern.evening + timePattern.night) / totalUses;
          if (nightRatio > 0.6) {
            return {
              classification: 'gaming',
              confidence: 0.40,
              source: 'micro-ai-time',
              reason: `Primarily used during evening/night (${Math.round(nightRatio * 100)}%) — likely entertainment`
            };
          }
        }
        if (currentSlot === 'morning' || currentSlot === 'afternoon') {
          const dayRatio = (timePattern.morning + timePattern.afternoon) / totalUses;
          if (dayRatio > 0.6) {
            return {
              classification: 'work',
              confidence: 0.40,
              source: 'micro-ai-time',
              reason: `Primarily used during work hours (${Math.round(dayRatio * 100)}%) — likely productive`
            };
          }
        }
      }
    }

    // No strong pattern — return neutral
    return null;
  },

  // Resolve 'ai-decide' classification using behavioral context
  _resolveAIDecide(proc, tit, profile) {
    // If behavioral history exists, use dominant class
    if (profile && profile.totalSessions >= 2) {
      const dominant = Object.entries(profile.classifications).sort((a, b) => b[1] - a[1])[0];
      if (dominant) return dominant[0];
    }
    // Default: browsers and chat apps → work during day, gaming at night
    const hour = new Date().getHours();
    const isDaytime = hour >= 7 && hour < 20;
    return isDaytime ? 'work' : 'gaming';
  }
};

// Track the previous process for transition learning
let microAIPrevProcess = null;
let microAICurrentProcessStart = Date.now();
let microAISaveCounter = 0;

// ═══════════════════════════════════════════════════════════
// STATE MACHINE ENGINE — Multi-Factor Confidence Scoring
// ═══════════════════════════════════════════════════════════

// Category definitions for process classification
const CreativeApps = [
  'premiere', 'resolve', 'photoshop', 'aftereffects', 'illustrator', 'indesign',
  'audition', 'lightroom', 'capcut', 'vegas', 'audacity', 'blender', 'cinema4d',
  'unreal', 'unity', 'obs', 'finalcut', 'imovie', 'kinemaster', 'filmora',
  'hitfilm', 'davinci', 'nuke', 'houdini', 'zbrush', 'substance', 'mudbox'
];

const DevTools = [
  'code', 'vscode', 'cursor', 'webstorm', 'intellij', 'pycharm', 'goland',
  'rubymine', 'phpstorm', 'xcode', 'androidstudio', 'devenv', 'rider',
  'clion', 'appcode', 'datagrip', 'terminal', 'iterm', 'warp', 'hyper',
  'cmd', 'powershell', 'node', 'electron', 'docker', 'postman', 'insomnia'
];

const ProductivityApps = [
  'figma', 'notion', 'slack', 'teams', 'zoom', 'outlook', 'word', 'excel',
  'powerpnt', 'onenote', 'evernote', 'trello', 'asana', 'linear', 'jira',
  'confluence', 'miro', 'lucid', 'airtable', 'clickup', 'monday', 'todoist',
  'ticktick', 'calendar', 'mail'
];

const EntertainmentSites = [
  // English
  'youtube', 'twitch', 'netflix', 'reddit', 'twitter', 'x.com', 'facebook',
  'instagram', 'tiktok', 'pinterest', 'tumblr', '9gag', 'imgur', 'hulu',
  'disney+', 'hbomax', 'primevideo', 'crunchyroll', 'funimation', 'vrv',
  // Multilingual entertainment portals
  'dailymotion', 'vk.com', 'ok.ru', 'bilibili', 'nicovideo',
  'weibo', 'douyin', 'youku', 'iqiyi', 'tencent',
  'naver', 'kakao', 'wikipedia.org',
];

const EducationalKeywords = [
  'tutorial', 'editing', 'premiere', 'development', 'programming', 'coding',
  'learn', 'course', 'udemy', 'coursera', 'skillshare', 'documentation',
  'stackoverflow', 'github', 'w3schools', 'mdn', 'wiki', 'howto', 'guide'
];

function classifyProcess(process, title) {
  const proc = (process || '').toLowerCase();
  const tit = (title || '').toLowerCase();

  // 1. Check explicit user classifications first (highest priority)
  let classification = config.processClassifications[proc];
  if (classification === 'both') classification = 'ai'; // migrate old values

  if (classification && classification !== 'ai') {
    const why = MicroAI.inferWhy(proc, tit, classification);
    return { classification, confidence: 1.0, source: 'user-rule', reason: `User-defined rule: ${classification}`, why };
  }

  // 2. AI Decide mode — dynamic evaluation based on context + MicroAI
  if (classification === 'ai') {
    return evaluateAIDecide(proc, tit);
  }

  // 3. Built-in category matching with confidence
  if (CreativeApps.some(app => proc.includes(app))) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.95, source: 'creative-app', reason: 'Creative editing application detected', why };
  }

  if (DevTools.some(app => proc.includes(app))) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.90, source: 'dev-tool', reason: 'Development tool detected', why };
  }

  if (ProductivityApps.some(app => proc.includes(app))) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.85, source: 'productivity-app', reason: 'Productivity application detected', why };
  }

  // Browser detection — analyze title
  const isBrowser = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'arc', 'safari', 'vivaldi'].some(b => proc.includes(b));
  if (isBrowser) {
    return classifyBrowserTab(proc, tit);
  }

  // Gaming detection
  if (config.gamingTrackingEnabled && config.gameKeywords.some(kw => proc.includes(kw))) {
    const isExcluded = DevTools.some(kw => proc.includes(kw));
    if (!isExcluded) {
      const why = MicroAI.inferWhy(proc, tit, 'gaming');
      return { classification: 'gaming', confidence: 0.90, source: 'game-process', reason: 'Gaming process detected', why };
    }
  }

  // File Explorer correlated with creative work
  if (proc === 'explorer' && (Date.now() - lastCreativeAppTime < 600000)) {
    return { classification: 'work', confidence: 0.70, source: 'correlated-explorer', reason: 'File Explorer active during creative workflow', why: MicroAI.inferWhy(proc, tit, 'work') };
  }

  // System processes
  const systemProcs = ['taskhostw', 'svchost', 'systemsettings', 'shellexperiencehost', 'applicationframehost', 'searchui', 'runtimebroker', 'sihost', 'taskbar', 'startmenuexperiencehost', 'searchhost'];
  if (systemProcs.some(kw => proc.includes(kw))) {
    return { classification: 'ignore', confidence: 0.80, source: 'system-process', reason: 'System process' };
  }

  // Desktop / empty window
  if (proc === 'explorer' && tit === '') {
    return { classification: 'ignore', confidence: 0.50, source: 'desktop', reason: 'Desktop window' };
  }

  // 4. MicroAI smart-classify for unknown processes (uses learned patterns)
  const microResult = MicroAI.smartClassify(proc, tit);
  if (microResult) {
    const why = MicroAI.inferWhy(proc, tit, microResult.classification);
    return { ...microResult, why };
  }

  // Unclassified — prompt user
  return { classification: null, confidence: 0, source: 'unclassified', reason: 'Unknown application', why: { reasons: [], confidence: 0, summary: `No data yet for ${proc} — still learning` } };
}

function classifyBrowserTab(proc, tit) {
  // YouTube special handling
  if (tit.includes('youtube')) {
    // 1. Educational content → work
    if (EducationalKeywords.some(kw => tit.includes(kw))) {
      return { classification: 'work', confidence: 0.85, source: 'youtube-educational', reason: 'YouTube educational content detected', why: MicroAI.inferWhy(proc, tit, 'work') };
    }

    // 2. YouTube with game/entertainment keywords → entertainment (NOT work)
    // This catches: "World of Tanks", "War Thunder gameplay", "LOL highlights", etc.
    // MULTILINGUAL: covers English, Spanish, Turkish, Russian, Arabic, German, French, Japanese, Chinese, Korean
    const youtubeGamingKeywords = [
      // English
      'gameplay', 'lets play', 'let\'s play', 'walkthrough', 'playthrough',
      'highlight', 'highlights', 'compilation', 'funny moments', 'montage',
      'world of tanks', 'war thunder', 'wot ', 'wt ', 'tank gameplay',
      'gaming', 'stream highlights', 'ranked', 'competitive', 'match',
      'kill montage', 'clutch', 'boss fight', 'raid', 'boss raid',
      'speedrun', 'speed run', 'emulator', 'retro gaming',
      'sims', 'simulator', 'sim ', 'truck sim', 'truck sims',
      'minecraft', 'valorant', 'fortnite', 'csgo', 'dota', 'lol ',
      'league of legends', 'overwatch', 'genshin', 'apex', 'pubg',
      'gta', 'cyberpunk', 'witcher', 'diablo', 'wow ', 'elden ring',
      'dark souls', 'sekiro', 'baldurs gate', 'hogwarts',
      'rdr2', 'red dead', 'spider-man', 'god of war', 'starfield',
      'destiny', 'halo', 'cod ', 'call of duty', 'battlefield',
      'rocket league', 'fall guys', 'among us', 'terraria',
      'stardew', 'factorio', 'civilization', 'xcom',
      'stream', 'livestream', 'live stream', 'twitch',
      'loot', 'opening', 'pack opening', 'unboxing', 'gacha',
      'chill', 'relaxing', 'asmr', 'music', 'song', 'playlist',
      'movie', 'film', 'trailer', 'review', 'reaction',
      'vlog', 'prank', 'challenge', 'meme', 'funny',
      // Spanish
      'juego', 'juegos', 'partida', 'diversión', 'consola', 'entretenimiento',
      'jugando', 'gameplay', 'strimer',
      // Turkish
      'oyun', 'eğlence', 'oynuyor', 'yayın',
      // Russian
      'игра', 'геймплей', 'игры', 'развлечение', 'стрим',
      // Arabic
      'لعب', 'ألع', 'ترفيه', 'بلايستيشن',
      // German
      'spiel', 'spiele', 'unterhaltung', 'lets play',
      // French
      'jeu', 'jeux', 'divertissement', 'amusant',
      // Japanese
      'ゲーム', 'プレイ', '娯楽',
      // Chinese
      '游戏', '娱乐', '玩法',
      // Korean
      '게임', '오락', '플레이',
    ];

    if (youtubeGamingKeywords.some(kw => tit.includes(kw))) {
      youtubeIdleTriggered = true;
      return { classification: 'entertainment', confidence: 0.80, source: 'youtube-gaming-content', reason: 'YouTube gaming/entertainment content detected', why: MicroAI.inferWhy(proc, tit, 'entertainment') };
    }

    // 3. Also check the game keywords from config
    if (config.gameKeywords.some(kw => tit.includes(kw))) {
      youtubeIdleTriggered = true;
      return { classification: 'entertainment', confidence: 0.75, source: 'youtube-game-keyword', reason: 'YouTube content matches gaming keywords', why: MicroAI.inferWhy(proc, tit, 'entertainment') };
    }

    // 4. YouTube grace period logic (no game keywords, no educational = generic YouTube)
    if (lastYouTubeActiveTime === 0) lastYouTubeActiveTime = Date.now();
    const youTubeWatchDuration = Date.now() - lastYouTubeActiveTime;

    if (youTubeWatchDuration > config.idleThresholdMs) {
      youtubeIdleTriggered = true;
      return { classification: 'entertainment', confidence: 0.60, source: 'youtube-entertainment', reason: 'YouTube entertainment (grace period expired)', why: MicroAI.inferWhy(proc, tit, 'entertainment') };
    } else {
      return { classification: 'work', confidence: 0.55, source: 'youtube-grace', reason: 'YouTube within grace period', why: MicroAI.inferWhy(proc, tit, 'work') };
    }
  }

  // Reset YouTube timer when off YouTube
  lastYouTubeActiveTime = 0;
  youtubeIdleTriggered = false;

  // Work keywords in title
  if (config.workKeywords.some(kw => tit.includes(kw))) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.80, source: 'work-keyword', reason: 'Work-related browser content detected', why };
  }

  // Entertainment sites
  if (EntertainmentSites.some(site => tit.includes(site))) {
    const why = MicroAI.inferWhy(proc, tit, 'entertainment');
    return { classification: 'entertainment', confidence: 0.85, source: 'entertainment-site', reason: 'Entertainment website detected', why };
  }

  // Game keywords in title (e.g., wiki for games)
  if (config.gameKeywords.some(kw => tit.includes(kw))) {
    const why = MicroAI.inferWhy(proc, tit, 'gaming');
    return { classification: 'gaming', confidence: 0.65, source: 'game-browser', reason: 'Gaming-related browser content', why };
  }

  // Default: general browsing as entertainment (news, blogs, shopping, search, etc.)
  const why = MicroAI.inferWhy(proc, tit, 'entertainment');
  return { classification: 'entertainment', confidence: 0.50, source: 'general-browsing', reason: 'General browsing (default entertainment classification)', why };
}

function evaluateAIDecide(proc, tit) {
  // AI assistant / dev tools → always work
  const isAIAssistant = ['antigravity', 'gemini', 'chatgpt', 'claude', 'copilot'].some(kw => proc.includes(kw) || tit.includes(kw));
  if (isAIAssistant) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.95, source: 'ai-assistant', reason: 'AI assistant detected as work tool', why };
  }

  if (DevTools.some(kw => proc.includes(kw))) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.90, source: 'ai-dev-tool', reason: 'Development tool (AI Decide)', why };
  }

  if (CreativeApps.some(kw => proc.includes(kw))) {
    const why = MicroAI.inferWhy(proc, tit, 'work');
    return { classification: 'work', confidence: 0.90, source: 'ai-creative', reason: 'Creative application (AI Decide)', why };
  }

  // Browser AI evaluation
  const isBrowser = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'arc'].some(b => proc.includes(b));
  if (isBrowser) {
    return classifyBrowserTab(proc, tit);
  }

  // Game keywords
  if (config.gameKeywords.some(kw => proc.includes(kw))) {
    const why = MicroAI.inferWhy(proc, tit, 'gaming');
    return { classification: 'gaming', confidence: 0.85, source: 'ai-game', reason: 'Gaming application (AI Decide)', why };
  }

  // MicroAI learned pattern for AI-decided processes
  const microResult = MicroAI.smartClassify(proc, tit);
  if (microResult && microResult.confidence > 0.45) {
    const why = MicroAI.inferWhy(proc, tit, microResult.classification);
    return { ...microResult, why };
  }

  // Default to work for AI Decide
  const why = MicroAI.inferWhy(proc, tit, 'work');
  return { classification: 'work', confidence: 0.45, source: 'ai-default', reason: 'AI Decide default: classified as work', why };
}

// ═══════════════════════════════════════════════════════════
// MAIN STATE EVALUATION (called every PowerShell tick)
// ═══════════════════════════════════════════════════════════

let lastTrackingWorkProcess = null;

function evaluateSystemState(status) {
  const now = Date.now();
  const process = (status.process || '').toLowerCase();
  const title = (status.title || '').toLowerCase();
  const idleMs = status.idleMs || 0;

  // Calculate elapsed
  const elapsedMs = now - lastTickTime;
  const elapsedSec = Math.max(0, elapsedMs / 1000.0);
  lastTickTime = now;

  // 1. Classify the current foreground process
  const result = classifyProcess(process, title);
  let classification = result.classification;
  let confidence = result.confidence;

  // MicroAI: Record process transitions and usage
  if (process && process !== microAIPrevProcess) {
    if (microAIPrevProcess) {
      // Record the duration of the previous process
      const prevDurSec = (now - microAICurrentProcessStart) / 1000;
      const prevProfile = MicroAI.behaviorProfile[microAIPrevProcess.toLowerCase()];
      if (prevProfile && prevDurSec > 0.5) {
        // Already recorded via appDurations — just record the transition
        MicroAI.recordTransition(microAIPrevProcess, process);
      }
    }
    microAIPrevProcess = process;
    microAICurrentProcessStart = now;

    // Periodic MicroAI save (every ~50 ticks ≈ 30s)
    microAISaveCounter++;
    if (microAISaveCounter >= 50) {
      microAISaveCounter = 0;
      MicroAI.save();
    }
  }

  // MicroAI: Record usage for the current process
  if (process && classification && classification !== 'ignore' && elapsedSec > 0) {
    MicroAI.recordUsage(process, title, classification, elapsedSec);
  }

  // 2. System idle check (overrides classification)
  const isSystemIdle = idleMs > config.idleThresholdMs;

  // 3. Determine the effective state
  let effectiveState = TrackingState.UNKNOWN;
  let isWorkDetected = false;
  let isGameDetected = false;

  if (isSystemIdle) {
    effectiveState = TrackingState.IDLE;
    confidence = 0.95;
  } else if (classification === 'work') {
    effectiveState = TrackingState.WORKING;
    isWorkDetected = true;
  } else if (classification === 'gaming') {
    effectiveState = TrackingState.GAMING;
    isGameDetected = true;
  } else if (classification === 'entertainment') {
    effectiveState = TrackingState.ENTERTAINMENT;
  } else if (classification === 'ignore' || classification === null) {
    // Unclassified or ignored apps — check if we're still "in context" of previous work
    const timeSinceWork = now - sessionWorkMs > 0 ? 0 : now; // simplified
    effectiveState = TrackingState.IDLE;
  }

  // 4. Focus streak tracking
  if (isWorkDetected && !isSystemIdle) {
    consecutiveWorkTicks++;

    if (focusStreakProcess !== process) {
      // New streak
      if (focusStreakStart && focusStreakProcess) {
        const streakMs = now - focusStreakStart;
        totalFocusStreakMs += streakMs;
        if (streakMs > longestFocusStreakMs) {
          longestFocusStreakMs = streakMs;
        }
        focusStreakCount++;
      }
      focusStreakStart = now;
      focusStreakProcess = process;
    }

    // Break suggestion
    if (config.breakRemindersEnabled && consecutiveWorkTicks >= BREAK_SUGGESTION_WORK_TICKS && now - breakSuggestedAt > BREAK_SUGGESTION_INTERVAL) {
      breakSuggestedAt = now;
      const streakMin = Math.floor((now - focusStreakStart) / 60000);
      sendToRenderer('break-suggestion', { streakMinutes: streakMin });
      sendNativeNotification('Take a Break ☕', `You've been focused for ${streakMin} minutes. A short break boosts productivity!`);
      addLog(`Break suggestion: ${streakMin} minute focus streak detected`, 'suggestion');
    }
  } else {
    consecutiveWorkTicks = 0;
    if (focusStreakStart && focusStreakProcess) {
      const streakMs = now - focusStreakStart;
      totalFocusStreakMs += streakMs;
      if (streakMs > longestFocusStreakMs) longestFocusStreakMs = streakMs;
      focusStreakCount++;
      focusStreakStart = null;
      focusStreakProcess = null;
    }
  }

  // 5. Session time accumulation
  if (effectiveState === TrackingState.WORKING) {
    sessionWorkMs += elapsedMs;
  } else if (effectiveState === TrackingState.GAMING) {
    sessionGamingMs += elapsedMs;
  } else if (effectiveState === TrackingState.ENTERTAINMENT) {
    sessionEntertainmentMs += elapsedMs;
  } else if (effectiveState === TrackingState.IDLE) {
    sessionIdleMs += elapsedMs;
  }

  // 6. Track per-app durations
  const isDesktop = process === 'explorer' && title === '';
  const isOverlaySelf = process === 'electron' && (title.includes('overlay') || title.includes('timeroi'));
  const isExcludedFromTracking = isOverlaySelf || isDesktop;

  if (process && !isExcludedFromTracking && !isSystemIdle && classification !== 'ignore') {
    appDurations[process] = (appDurations[process] || 0) + elapsedSec;
    sendToRenderer('app-durations-update', appDurations);
  }

  // 7. Update creative app correlation timestamp
  if (CreativeApps.some(app => process.includes(app))) {
    lastCreativeAppTime = now;
  }

  // 8. State transition detection with smoothing
  stateHistory.push(effectiveState);
  if (stateHistory.length > HISTORY_WINDOW) stateHistory.shift();

  // Smoothed state: most common in recent window
  const stateCounts = {};
  stateHistory.forEach(s => { stateCounts[s] = (stateCounts[s] || 0) + 1; });
  let smoothedState = effectiveState;
  let maxCount = 0;
  Object.entries(stateCounts).forEach(([state, count]) => {
    if (count > maxCount) { maxCount = count; smoothedState = state; }
  });

  // 9. Detect state transitions
  if (smoothedState !== currentState) {
    previousState = currentState;
    currentState = smoothedState;

    onStateTransition(previousState, currentState, process, title, confidence, result);
  }

  // 10. Auto-start/stop tracking logic
  if (isWorkDetected && !isSystemIdle) {
    const isWorkProgram = CreativeApps.some(app => process.includes(app)) || DevTools.some(app => process.includes(app));

    // Auto-start for work programs
    if (config.autoTrackingEnabled && isWorkProgram && !isTracking) {
      addLog(`${process} active. Auto-start request triggered`, 'auto');
      sendToRenderer('auto-start-request', { process, title, confidence: result.confidence, source: result.source });
      sendToWebClient({ type: 'auto-start-request', data: { process, title } });
    }

    // Track which work process started this timer
    if (isTracking && isWorkProgram) {
      lastTrackingWorkProcess = process;
    }
  }

  // Auto-stop when work process is closed
  if (isTracking && lastTrackingWorkProcess && !CreativeApps.some(app => process.includes(app)) && process !== lastTrackingWorkProcess) {
    if (isGameDetected || process === '' || (now - lastCreativeAppTime > 30000)) {
      addLog(`Work process "${lastTrackingWorkProcess}" closed. Auto-stopping timer.`, 'auto');
      sendToRenderer('auto-stop-request');
      lastTrackingWorkProcess = null;
    }
  }

  // 11. Send real-time updates to renderer
  sendToRenderer('raw-focus-update', { process, title, idleMs, confidence, classification: classification || 'unclassified', source: result.source, why: result.why || null });

  sendToRenderer('state-change', {
    state: currentState,
    previousState,
    confidence,
    source: result.source,
    reason: result.reason,
    why: result.why || null,
    focusStreak: focusStreakStart ? Math.floor((now - focusStreakStart) / 60000) : 0,
    sessionWorkMs,
    sessionGamingMs,
    sessionEntertainmentMs,
    sessionIdleMs,
    process,
    title
  });

  // 12. Overlay logic for unclassified processes
  if (process !== lastOverlayProcess) {
    lastOverlayProcess = process;
    overlayDismissedForProcess = null;
  }

  const hasRect = status.left !== undefined && status.right !== undefined && status.top !== undefined && status.bottom !== undefined;
  const shouldShowOverlay = process &&
    !isExcludedFromTracking &&
    !isDesktop &&
    !isOverlaySelf &&
    !isSystemIdle &&
    hasRect &&
    (status.right - status.left) > 200 &&
    classification === null &&
    overlayDismissedForProcess !== process;

  if (shouldShowOverlay && overlayWindow && !overlayWindow.isDestroyed()) {
    repositionOverlay({ left: status.left, top: status.top, right: status.right, bottom: status.bottom });
    const seconds = Math.floor(appDurations[process] || 0);
    overlayWindow.webContents.send('active-window-update', {
      process,
      classification: 'unclassified',
      timeText: formatAppDuration(seconds),
      isIdle: isSystemIdle,
      confidence: 0
    });
  } else {
    const isDifferent = process !== lastOverlayProcess;
    if (overlayWindow && !overlayWindow.isDestroyed() && !isOverlaySelf) {
      if (isDifferent || isSystemIdle || isExcludedFromTracking || isDesktop) {
        overlayWindow.hide();
      }
    }
  }

  // 13. Prompt user to classify unclassified processes in dashboard (Disabled: overlay is the single source)
  if (process && !classification && !isExcludedFromTracking && !CreativeApps.some(app => process.includes(app)) && !isDesktop) {
    if (config.gameKeywords.some(kw => process.includes(kw))) {
      config.processClassifications[process] = 'gaming';
      saveConfig();
    } else if (config.onlineSearchEnabled !== false && !isOverlaySelf && !isSystemIdle) {
      lookupProcessOnline(process);
    }
  }

  // 14. Daily stats periodic save
  saveDailyStats();
}

function onStateTransition(from, to, process, title, confidence, result) {
  const fromLabel = from.charAt(0).toUpperCase() + from.slice(1);
  const toLabel = to.charAt(0).toUpperCase() + to.slice(1);

  addLog(`State transition: ${fromLabel} → ${toLabel} (${(confidence * 100).toFixed(0)}% confidence)`, 'transition');

  // Notify web client
  sendToWebClient({
    type: 'state-change',
    data: { state: to, previousState: from, process, title, confidence }
  });

  // Send native notification for important transitions
  if (to === TrackingState.IDLE && from === TrackingState.WORKING) {
    let reason = 'unrelated_app';
    if (result.source.includes('youtube')) reason = 'youtube_distraction';
    else if (result.source.includes('system')) reason = 'system_inactivity';

    const eventData = {
      reason,
      durationMs: Date.now() - lastTickTime,
      subtractSeconds: Math.floor(config.idleThresholdMs / 1000)
    };

    if (config.autoTrackingEnabled) {
      sendToRenderer('idle-trigger', eventData);
      sendToWebClient({ type: 'idle-trigger', data: eventData });
    }
  }

  // Back to Work notification removed per user request (keeping only Break suggestion)
}

// ═══════════════════════════════════════════════════════════
// WINDOW MANAGEMENT
// ═══════════════════════════════════════════════════════════

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  const shouldShow = !process.argv.includes('--hidden');

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 900,
    minHeight: 680,
    frame: true,
    show: shouldShow,
    title: 'TIMEROI',
    icon: icon,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#09090b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    app.isQuitting = true;
    if (psProcess) {
      try {
        psProcess.kill();
      } catch (e) {}
    }
    app.quit();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open TIMEROI', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    {
      label: 'Pause Auto-Tracking',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        sendToRenderer('pause-override-changed', item.checked);
        addLog(item.checked ? 'Auto-tracking paused by user' : 'Auto-tracking resumed', 'user');
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('TIMEROI');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 160,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function repositionOverlay(rect) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const width = 420;
  const height = 160;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workArea;

  let targetX = (screenWidth - width) / 2;
  let targetY = 24;

  overlayWindow.setBounds({
    x: Math.round(targetX),
    y: Math.round(targetY),
    width,
    height
  });

  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }
}

// ═══════════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════

function startWebSocketServer() {
  wss = new WebSocket.Server({ port: 8032 });

  wss.on('connection', (ws) => {
    activeClientWs = ws;
    addLog('Web client connected', 'connection');

    ws.send(JSON.stringify({
      type: 'init',
      data: { agent: 'TIMEROI', version: '2.0.0', features: ['confidence-scoring', 'focus-streaks', 'break-detection', 'daily-stats'] }
    }));

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'timer-state-update') {
          isTracking = parsed.data.isTracking;
          activeClientId = parsed.data.clientId;
          activeVideoId = parsed.data.videoId;
          sendToRenderer('web-tracking-update', parsed.data);
        }
      } catch (err) {
        console.error('Error parsing web client message:', err);
      }
    });

    ws.on('close', () => {
      addLog('Web client disconnected', 'connection');
      activeClientWs = null;
      sendToRenderer('web-connection-status', false);
    });

    sendToRenderer('web-connection-status', true);
  });
}

function sendToWebClient(msg) {
  if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
    activeClientWs.send(JSON.stringify(msg));
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ═══════════════════════════════════════════════════════════
// POWERSHELL OS TRACKER
// ═══════════════════════════════════════════════════════════

function startPowerShellTracker() {
  const userDataPath = app.getPath('userData');
  const psScriptPath = path.join(userDataPath, 'win-tracker.ps1');

  try {
    const sourcePath = path.join(__dirname, 'win-tracker.ps1');
    const scriptContent = fs.readFileSync(sourcePath, 'utf8');
    fs.writeFileSync(psScriptPath, scriptContent, 'utf8');
  } catch (err) {
    console.error('Failed to copy win-tracker.ps1 to userData:', err);
  }

  psProcess = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `& '${psScriptPath}'`
  ]);

  let stdoutBuffer = '';

  psProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    let boundary = stdoutBuffer.indexOf('\n');

    while (boundary !== -1) {
      const line = stdoutBuffer.substring(0, boundary).trim();
      stdoutBuffer = stdoutBuffer.substring(boundary + 1);

      if (line) {
        try {
          const status = JSON.parse(line);
          evaluateSystemState(status);
        } catch (err) {
          // Fragment — wait for full line
        }
      }
      boundary = stdoutBuffer.indexOf('\n');
    }
  });

  psProcess.stderr.on('data', (data) => {
    console.error('PS Error:', data.toString());
  });

  psProcess.on('close', (code) => {
    if (!app.isQuitting) {
      addLog('OS Monitor process closed. Restarting...', 'error');
      setTimeout(startPowerShellTracker, 3000);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function formatAppDuration(totalSeconds) {
  if (!totalSeconds) return '0s';
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);

  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// ═══════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════

// Enforce Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    loadAppDurations();
    loadDailyStats();
    MicroAI.load();
    createWindow();
    createOverlayWindow();
    createTray();
    startWebSocketServer();
    startPowerShellTracker();
    initializeModelSync();

    // Periodic autosave
    setInterval(saveAppDurations, 10000);
    setInterval(saveDailyStats, 60000);

    // App Update Checker
    setTimeout(checkForAppUpdates, 5000);
    setInterval(checkForAppUpdates, 6 * 60 * 60 * 1000); // Check every 6 hours

    try {
      app.setLoginItemSettings({
        openAtLogin: config.autoStartOnBoot,
        path: app.getPath('exe'),
        args: config.startMinimized ? ['--hidden'] : []
      });
    } catch (err) {
      console.error('Login settings failed:', err);
    }

    addLog('TIMEROI initialized — enhanced tracking engine v2.0 active', 'system');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        createOverlayWindow();
      }
    });
  });
}

app.on('will-quit', () => {
  saveAppDurations();
  saveDailyStats();
  MicroAI.save();
  if (psProcess) {
    try {
      psProcess.kill();
    } catch (e) {}
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// ═══════════════════════════════════════════════════════════
// IPC HANDLERS
// ═══════════════════════════════════════════════════════════

ipcMain.on('get-initial-state', (event) => {
  event.reply('initial-state', {
    config,
    logs: activityLogs,
    isTracking,
    appDurations,
    dailyStats,
    sessionStats: {
      workMs: sessionWorkMs,
      gamingMs: sessionGamingMs,
      entertainmentMs: sessionEntertainmentMs,
      idleMs: sessionIdleMs,
      focusStreakCount,
      longestFocusStreakMs,
      currentStreakMs: focusStreakStart ? Date.now() - focusStreakStart : 0
    }
  });

  if (modelSync) {
    const status = modelSync.getStatus();
    const statusText = status.isOnline ? `Online (v${status.version})` : 'Offline';
    sendModelSyncStatus(statusText, status.isOnline);
  } else {
    sendModelSyncStatus('Sync Disabled', false);
  }
});

ipcMain.on('update-config', (event, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig();
  initializeModelSync();

  try {
    app.setLoginItemSettings({
      openAtLogin: config.autoStartOnBoot,
      path: app.getPath('exe'),
      args: config.startMinimized ? ['--hidden'] : []
    });
  } catch (err) {
    console.error('Login settings update failed:', err);
  }

  addLog('Configuration updated', 'user');
  event.reply('config-updated', config);
});

ipcMain.on('set-timer-tracking-state', (event, state) => {
  isTracking = state.isTracking;
  activeClientId = state.clientId;
  activeVideoId = state.videoId;

  sendToWebClient({
    type: 'timer-state-update',
    data: state
  });
});

ipcMain.on('manual-log-sync', (event, logEntry) => {
  activityLogs.unshift(typeof logEntry === 'string' ? { time: new Date().toLocaleTimeString(), message: logEntry, type: 'info', timestamp: Date.now() } : logEntry);
  if (activityLogs.length > 200) activityLogs.pop();
});

ipcMain.on('timer-tick-sync', (event, data) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-state-update', data);
  }
});

ipcMain.on('overlay-toggle-click', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-toggle-timer');
  }
});

ipcMain.on('minimize-main-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.on('resize-overlay', (event, { width, height }) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setSize(width, height);
  }
});

ipcMain.on('hide-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  overlayDismissedForProcess = lastOverlayProcess;
});

ipcMain.on('classify-process-response', (event, { process, classification }) => {
  config.processClassifications[process] = classification;
  saveConfig();
  addLog(`"${process}" classified as: ${classification}`, 'classification');

  // Strong training signal: user explicitly told us the answer
  if (MicroAI.net) {
    MicroAI.net.learn(process, '', classification, 0.05);
  }

  // Queue and push to Model Sync if sharing is enabled
  if (modelSync && config.modelSharingEnabled) {
    modelSync.queueClassification(process, classification);
    if (config.githubToken) {
      modelSync.uploadClassifications(config.githubToken)
        .then(() => {
          const status = modelSync.getStatus();
          sendModelSyncStatus(`Synched (v${status.version})`, true);
        })
        .catch(err => {
          sendModelSyncStatus('Upload Error', false);
        });
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', config);
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const seconds = Math.floor(appDurations[process] || 0);
    overlayWindow.webContents.send('active-window-update', {
      process,
      classification,
      timeText: formatAppDuration(seconds),
      isIdle: false
    });
  }

  overlayDismissedForProcess = process;
});

ipcMain.on('ai-classify-request', (event, processName) => {
  const procLower = processName.toLowerCase();
  let classification = 'work';
  let reason = 'Classified as work by general productivity fallback.';

  // First try MicroAI's learned patterns
  const microResult = MicroAI.smartClassify(procLower, '');
  if (microResult && microResult.confidence > 0.5) {
    classification = microResult.classification;
    reason = microResult.reason;
  } else {
    // Fallback to heuristic rules
    const isWorkKw = config.workKeywords.some(kw => procLower.includes(kw));
    const isGameKw = config.gameKeywords.some(kw => procLower.includes(kw));

    if (isWorkKw) {
      classification = 'work';
      reason = 'Matches your customized work keyword filter.';
    } else if (isGameKw) {
      classification = 'gaming';
      reason = 'Matches your customized gaming keyword filter.';
    } else if (CreativeApps.some(app => procLower.includes(app))) {
      classification = 'work';
      reason = 'AI identified this as a creative editing application.';
    } else if (DevTools.some(app => procLower.includes(app))) {
      classification = 'work';
      reason = 'AI identified this as a development tool.';
    } else if (ProductivityApps.some(app => procLower.includes(app))) {
      classification = 'work';
      reason = 'AI identified this as a productivity application.';
    } else if (EntertainmentSites.some(site => procLower.includes(site))) {
      classification = 'entertainment';
      reason = 'AI identified this as an entertainment platform.';
    }
  }

  // Get the WHY insight for the overlay
  const why = MicroAI.inferWhy(procLower, '', classification);

  config.processClassifications[processName] = classification;
  saveConfig();
  addLog(`[MicroAI] "${processName}" → ${classification} (${(why.confidence * 100).toFixed(0)}% confidence)`, 'classification');

  // Train neural net on this AI decision
  if (MicroAI.net) {
    MicroAI.net.learn(processName, '', classification, 0.03);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', config);
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('ai-classify-response', {
      process: processName,
      classification,
      reason,
      why: why.summary
    });
  }

  overlayDismissedForProcess = processName;
});

ipcMain.on('get-daily-stats', (event) => {
  event.reply('daily-stats-response', dailyStats);
});

ipcMain.on('get-session-stats', (event) => {
  event.reply('session-stats-response', {
    workMs: sessionWorkMs,
    gamingMs: sessionGamingMs,
    entertainmentMs: sessionEntertainmentMs,
    idleMs: sessionIdleMs,
    focusStreakCount,
    longestFocusStreakMs,
    currentStreakMs: focusStreakStart ? Date.now() - focusStreakStart : 0,
    currentState,
    sessionDuration: Date.now() - sessionStartTime
  });
});

ipcMain.on('get-micro-ai-insight', (event, processName) => {
  const proc = (processName || '').toLowerCase();
  const why = MicroAI.inferWhy(proc, '', 'unknown');
  const smartResult = MicroAI.smartClassify(proc, '');

  // Get neural net prediction details
  let nnDetails = null;
  try {
    if (MicroAI.net && embedProcessInfoFn) {
      const input = embedProcessInfoFn(proc, '');
      const { probs } = MicroAI.net.predict(input);
      nnDetails = {
        work: (probs[0] * 100).toFixed(1) + '%',
        gaming: (probs[1] * 100).toFixed(1) + '%',
        entertainment: (probs[2] * 100).toFixed(1) + '%',
        ignore: (probs[3] * 100).toFixed(1) + '%',
        aiDecide: (probs[4] * 100).toFixed(1) + '%'
      };
    }
  } catch (err) { /* silent */ }

  const profile = MicroAI.behaviorProfile[proc];

  event.reply('micro-ai-insight-response', {
    process: proc,
    why,
    smartSuggestion: smartResult,
    neuralNet: nnDetails,
    trainedCount: MicroAI.net ? MicroAI.net.trained : 0,
    profile: profile ? {
      totalSessions: profile.totalSessions,
      avgDurationSec: Math.floor(profile.avgDurationSec),
      dominantClass: Object.entries(profile.classifications).sort((a, b) => b[1] - a[1])[0],
      timePattern: MicroAI.timePatterns[proc] || null,
      topTransitions: MicroAI.transitionGraph[proc]
        ? Object.entries(MicroAI.transitionGraph[proc]).sort((a, b) => b[1] - a[1]).slice(0, 3)
        : []
    } : null
  });
});

// ═══════════════════════════════════════════════════════════
// MODEL SYNC INITIALIZATION & IPC TRIGGERS
// ═══════════════════════════════════════════════════════════

function initializeModelSync() {
  if (!config.modelSharingEnabled) {
    if (modelSync) {
      modelSync.stop();
      modelSync = null;
    }
    sendModelSyncStatus('Sync Disabled', false);
    return;
  }

  if (modelSync) return; // already initialized

  try {
    modelSync = new ModelSync();

    modelSync.onWeightsUpdate = (weightsData) => {
      if (MicroAI.net) {
        try {
          MicroAI.net.deserialize(weightsData);
          MicroAI.save();
          addLog('[ModelSync] Loaded updated pre-trained weights from community cloud', 'system');
          const status = modelSync.getStatus();
          sendModelSyncStatus(`Synched (v${status.version})`, true);
        } catch (err) {
          console.error('[ModelSync] Failed to apply remote weights:', err);
          sendModelSyncStatus('Sync Load Error', false);
        }
      }
    };

    modelSync.onClassificationsUpdate = (classifications) => {
      let mergedCount = 0;
      for (const [proc, cl] of Object.entries(classifications)) {
        if (!config.processClassifications[proc]) {
          config.processClassifications[proc] = cl;
          mergedCount++;
        }
      }
      if (mergedCount > 0) {
        saveConfig();
        addLog(`[ModelSync] Merged ${mergedCount} community classification rules`, 'system');
        sendToRenderer('config-updated', config);
      }
    };

    modelSync.onNewVersion = (version) => {
      addLog(`[ModelSync] Model updated to community version v${version}`, 'system');
      const status = modelSync.getStatus();
      sendModelSyncStatus(`Synched (v${status.version})`, true);
    };

    modelSync.start();
    const status = modelSync.getStatus();
    sendModelSyncStatus(status.isOnline ? `Synched (v${status.version})` : 'Online', true);

  } catch (err) {
    console.error('[ModelSync] Initialization error:', err);
    sendModelSyncStatus('Offline', false);
  }
}

function sendModelSyncStatus(statusText, isOnline) {
  sendToRenderer('model-sync-status', { statusText, isOnline });
}

ipcMain.on('force-model-sync', (event) => {
  if (modelSync) {
    sendModelSyncStatus('Syncing...', true);
    modelSync.checkForUpdates()
      .then(() => {
        const status = modelSync.getStatus();
        sendModelSyncStatus(`Synched (v${status.version})`, true);
      })
      .catch(err => {
        console.error('[ModelSync] Force sync error:', err);
        sendModelSyncStatus('Sync Failed', false);
      });
  } else {
    initializeModelSync();
  }
});

// ═══════════════════════════════════════════════════════════
// ONLINE APP SEARCH & AUTO-CLASSIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════

const activeLookups = new Set();

function cleanProcessName(proc) {
  let cleaned = proc.replace(/\.exe$/i, '').trim().toLowerCase();
  
  const mappings = {
    'code': 'visual studio code',
    'devenv': 'microsoft visual studio',
    'resolve': 'davinci resolve',
    'chrome': 'google chrome',
    'msedge': 'microsoft edge',
    'acrord32': 'adobe acrobat reader',
    'photoshop': 'adobe photoshop',
    'illustrator': 'adobe illustrator',
    'premiere': 'adobe premiere pro',
    'afterfx': 'adobe after effects',
    'obs64': 'obs studio',
    'obs': 'obs studio',
    'tl': 'throne and liberty game',
    'vlc': 'vlc media player',
    'utorrent': 'utorrent client',
    'webstorm': 'jetbrains webstorm',
    'pycharm': 'jetbrains pycharm',
    'idea64': 'intellij idea',
    'excel': 'microsoft excel',
    'winword': 'microsoft word',
    'powerpnt': 'microsoft powerpoint',
    'robloxplayerbeta': 'roblox',
    'robloxplayer': 'roblox',
    'spotify': 'spotify music',
    'discord': 'discord chat'
  };
  
  if (mappings[cleaned]) {
    return mappings[cleaned];
  }
  
  // Clean characters
  cleaned = cleaned.replace(/[-_]+/g, ' ');
  cleaned = cleaned.replace(/([a-z])([A-Z])/g, '$1 $2');
  
  // Strip common executable suffix phrases (so robloxplayerbeta -> roblox)
  const suffixes = [
    'playerbeta', 'player', 'launcher', 'client', 'setup', 'win64', 'win32', 
    'x64', 'x86', 'desktop', 'app', 'agent', 'service', 'host', 'helper', 
    'manager', 'utility', 'ui', 'core', 'canary', 'ptb'
  ];
  
  suffixes.forEach(suffix => {
    const regex = new RegExp(`\\b${suffix}\\b|${suffix}$`, 'i');
    cleaned = cleaned.replace(regex, '');
  });
  
  cleaned = cleaned.trim().replace(/\s+/g, ' ');
  
  return cleaned || proc.replace(/\.exe$/i, '');
}

function performWikipediaSearch(query) {
  return new Promise((resolve) => {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
    
    const options = {
      headers: {
        'User-Agent': 'TIMEROI-Desktop-Agent/1.0 (contact@timeroi.com)'
      },
      timeout: 5000
    };

    const req = https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed[2] && parsed[2][0]) {
            resolve({
              title: parsed[1][0],
              description: parsed[2][0],
              link: parsed[3][0]
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

function determineCategoryFromDescription(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  
  let scores = {
    work: 0,
    gaming: 0,
    entertainment: 0,
    ignore: 0
  };

  const gamingKeywords = [
    'video game', 'multiplayer', 'online game', 'game console', 'gameplay',
    'esports', 'mmorpg', 'role-playing game', 'first-person shooter',
    'simulation game', 'steam', 'valve corporation', 'riot games', 'epic games',
    'nintendo', 'playstation', 'xbox', 'blizzard entertainment', 'video games'
  ];
  gamingKeywords.forEach(kw => {
    if (text.includes(kw)) scores.gaming += 2;
  });
  if (/\b(game|games|gaming|play|player|arcade|battle|combat|puzzle)\b/.test(text)) {
    scores.gaming += 1.5;
  }

  const workKeywords = [
    'graphics editor', 'development environment', 'ide', 'text editor',
    'vector graphics', '3d computer graphics', 'video editing', 'word processor',
    'spreadsheet', 'database management', 'version control', 'git repository',
    'collaboration platform', 'productivity software', 'office suite', 'cad',
    'design tool', 'compiler', 'software development', 'project management',
    'non-linear video', 'audio editor', 'compositing', 'rendering', '3d modeling'
  ];
  workKeywords.forEach(kw => {
    if (text.includes(kw)) scores.work += 2;
  });
  if (/\b(developer|development|programming|code|compiler|database|spreadsheet|editor|creative|design|workflow|productivity|project|manage|business)\b/.test(text)) {
    scores.work += 1.2;
  }

  const entKeywords = [
    'audio streaming', 'video sharing', 'media provider', 'social network',
    'social media', 'movie', 'tv show', 'television', 'streaming service',
    'music streaming', 'podcast', 'video hosting', 'microblogging'
  ];
  entKeywords.forEach(kw => {
    if (text.includes(kw)) scores.entertainment += 2;
  });
  if (/\b(streaming|music|video|audio|movie|movies|song|songs|social|chat|messenger|chatting|friends)\b/.test(text)) {
    scores.entertainment += 1.2;
  }

  const ignoreKeywords = [
    'operating system', 'system process', 'driver', 'utility program',
    'background process', 'windows service', 'anti-virus', 'security software'
  ];
  ignoreKeywords.forEach(kw => {
    if (text.includes(kw)) scores.ignore += 2;
  });
  if (/\b(driver|system|helper|service|utility|background)\b/.test(text)) {
    scores.ignore += 1.2;
  }

  let bestClass = null;
  let bestScore = 0;
  for (const [cls, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestClass = cls;
    }
  }

  if (bestScore >= 1.5) {
    return { classification: bestClass, confidence: Math.min(0.95, 0.5 + bestScore * 0.15) };
  }

  return null;
}

async function lookupProcessOnline(process) {
  if (!process || activeLookups.has(process)) return;
  activeLookups.add(process);
  
  const cleaned = cleanProcessName(process);
  console.log(`[Online Search] Running online lookup for unrecognized app: "${process}" (cleaned: "${cleaned}")`);
  addLog(`Unrecognized app: Searching online for "${process}"...`, 'system');
  
  let result = await performWikipediaSearch(cleaned);
  
  if (!result) {
    result = await performWikipediaSearch(cleaned + ' software');
  }
  
  if (!result) {
    result = await performWikipediaSearch(cleaned + ' game');
  }

  if (result && result.description) {
    const classificationResult = determineCategoryFromDescription(result.title, result.description);
    
    if (classificationResult) {
      const { classification } = classificationResult;
      console.log(`[Online Search] Auto-classified "${process}" as "${classification}" based on online search for "${result.title}"`);
      
      // Update config
      config.processClassifications[process] = classification;
      saveConfig();
      
      // Train neural network
      if (MicroAI.net) {
        try {
          MicroAI.net.learn(process, result.description, classification, 0.05);
          MicroAI.save();
        } catch (err) {
          console.error('[Online Search] Neural net learn error:', err);
        }
      }
      
      // Update renderer config
      sendToRenderer('config-updated', config);
      
      // Log it
      addLog(`AI online lookup: Auto-classified "${process}" as ${classification} (${result.title})`, 'system');
      
      // Toast notification
      sendNativeNotification(
        'AI Auto-Classification',
        `Recognized "${process}" as ${classification.toUpperCase()} (${result.title})`,
        'success'
      );
      
      // Hide overlay if it is open for this process
      if (overlayWindow && !overlayWindow.isDestroyed() && lastOverlayProcess === process) {
        overlayWindow.hide();
      }
      
      return;
    }
  }
  
  console.log(`[Online Search] No confident classification found online for "${process}"`);
  addLog(`AI online lookup: Could not classify "${process}" automatically.`, 'system');
}

// ═══════════════════════════════════════════════════════════
// AUTOMATED APPLICATION UPDATE CHECKER
// ═══════════════════════════════════════════════════════════

function checkForAppUpdates() {
  const currentVersion = app.getVersion();
  const url = 'https://raw.githubusercontent.com/Chingolem/MnaagmentAPP/main/app-version.json';
  
  console.log(`[AppUpdate] Checking for updates... Current version: ${currentVersion}`);
  
  const options = {
    headers: {
      'User-Agent': 'TIMEROI-Desktop-Agent/1.0'
    },
    timeout: 5000
  };

  const req = https.get(url, options, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      console.log(`[AppUpdate] Update check skipped (HTTP ${res.statusCode})`);
      return;
    }

    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const info = JSON.parse(data);
        if (info && info.version && isNewerVersion(info.version, currentVersion)) {
          console.log(`[AppUpdate] New version available: v${info.version}`);
          sendToRenderer('app-update-available', info);
          
          sendNativeNotification(
            'TIMEROI Update Available',
            `Version ${info.version} is now available. Click to download!`,
            'info'
          );
        } else {
          console.log('[AppUpdate] App is up to date.');
        }
      } catch (err) {
        console.error('[AppUpdate] Failed to parse update JSON:', err);
      }
    });
  });

  req.on('error', (err) => {
    console.error('[AppUpdate] Check failed:', err);
  });
}

function isNewerVersion(latest, current) {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);
  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

ipcMain.on('start-update-download', (event, downloadUrl) => {
  const tempDir = app.getPath('temp');
  const targetPath = path.join(tempDir, 'timeroi-setup-update.exe');
  
  if (fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(targetPath);
    } catch (e) {
      console.error('[AppUpdate] Failed to remove old setup file:', e);
    }
  }

  const file = fs.createWriteStream(targetPath);
  console.log(`[AppUpdate] Starting download from ${downloadUrl} to ${targetPath}`);
  
  const options = {
    headers: {
      'User-Agent': 'TIMEROI-Desktop-Agent/1.0'
    },
    timeout: 30000
  };

  function getRedirected(url) {
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        getRedirected(res.headers.location);
        return;
      }

      if (res.statusCode !== 200) {
        event.reply('update-download-error', `Server returned HTTP ${res.statusCode}`);
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        file.write(chunk);
        
        if (totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          event.reply('update-download-progress', percent);
        }
      });

      res.on('end', () => {
        file.end();
        console.log('[AppUpdate] Download complete. Spawning installer...');
        event.reply('update-download-complete');
        
        // Spawn installer and quit app
        setTimeout(() => {
          try {
            const child = spawn(targetPath, [], {
              detached: true,
              stdio: 'ignore'
            });
            child.unref();
            app.quit();
          } catch (err) {
            console.error('[AppUpdate] Spawning installer failed:', err);
            event.reply('update-download-error', `Failed to execute installer: ${err.message}`);
          }
        }, 1500);
      });
    }).on('error', (err) => {
      file.end();
      fs.unlink(targetPath, () => {});
      event.reply('update-download-error', err.message);
    });
  }

  getRedirected(downloadUrl);
});


