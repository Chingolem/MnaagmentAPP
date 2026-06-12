const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

// WebSocket Port
const PORT = 8032;
const wss = new WebSocket.Server({ port: PORT });

console.log(`[TIMEROI Agent] Background WebSocket server started on ws://localhost:${PORT}`);

// Active tracking configuration
const WORK_WEBSITE_KEYWORDS = [
  'envato', 'elements.envato', 'motionarray', 'artlist', 'shutterstock', 
  'behance', 'soundstripe', 'fiverr', 'upwork', 'editing', 'assets', 
  'fonts', 'stock', 'github', 'supabase', 'vercel', 'stack overflow',
  'localhost', 'google translate', 'managment'
];

const GAME_PROCESS_KEYWORDS = [
  'steam', 'valorant', 'leagueoflegends', 'dota2', 'valheim', 'csgo', 
  'minecraft', 'wow', 'warmane', 'diablo', 'cyberpunk', 'witcher', 
  'gta5', 'fortnite', 'epicgames', 'origin', 'r5apex', 'pubg',
  'riotclient', 'overwatch', 'genshinimpact'
];

// State tracking variables
let activeClientWs = null;
let currentTrackingState = {
  activeClientId: null,
  activeVideoId: null,
  isTracking: false,
  lastStartTime: null,
  totalSeconds: 0
};

// State Machine Variables
let lastWorkTime = Date.now();
let isIdle = false;
let isGaming = false;
let lastPremiereActiveTime = 0;
let lastYouTubeActiveTime = 0;
let youtubeIdleTriggered = false;

// Statistics or temporary logs
let activeProcess = '';
let activeTitle = '';
let idleMs = 0;

// Spawn PowerShell window tracking helper
const startPowerShellTracker = () => {
  const psScriptPath = path.join(__dirname, 'win-tracker.ps1');
  console.log(`[TIMEROI Agent] Spawning PowerShell tracker script: ${psScriptPath}`);
  
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    psScriptPath
  ]);

  ps.stdout.on('data', (data) => {
    const lines = data.toString().split('\r\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const status = JSON.parse(line);
        processStatusUpdate(status);
      } catch (err) {
        // Output might be fragmented, wait for full line
      }
    }
  });

  ps.stderr.on('data', (data) => {
    console.error(`[PowerShell Error] ${data.toString()}`);
  });

  ps.on('close', (code) => {
    console.log(`[TIMEROI Agent] PowerShell tracker exited with code ${code}. Restarting...`);
    setTimeout(startPowerShellTracker, 3000);
  });
};

// Process status updates from PowerShell (runs every 1.5 seconds)
const processStatusUpdate = (status) => {
  activeProcess = (status.process || '').toLowerCase();
  activeTitle = (status.title || '').toLowerCase();
  idleMs = status.idleMs || 0;

  const now = Date.now();
  let isWorkDetected = false;
  let isGameDetected = false;

  // 1. Detect Premiere Pro
  if (activeProcess.includes('premiere')) {
    isWorkDetected = true;
    lastPremiereActiveTime = now;
  }

  // 2. Detect File Explorer (correlated with Premiere Pro in the last 10 minutes)
  if (activeProcess === 'explorer' && (now - lastPremiereActiveTime < 600000)) {
    isWorkDetected = true;
  }

  // 3. Detect Browser Work Tabs vs YouTube
  const isBrowser = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'iexplore', 'browser'].some(b => activeProcess.includes(b));
  if (isBrowser) {
    // Check if browser title contains YouTube
    const isYouTube = activeTitle.includes('youtube');
    
    if (isYouTube) {
      // YouTube Tutorials count as work
      if (activeTitle.includes('tutorial') || activeTitle.includes('editing') || activeTitle.includes('premiere')) {
        isWorkDetected = true;
        youtubeIdleTriggered = false;
      } else {
        // General YouTube video
        if (lastYouTubeActiveTime === 0) {
          lastYouTubeActiveTime = now;
        }
        // If YouTube is open for more than 2 minutes (120000 ms), count as idle
        if (now - lastYouTubeActiveTime > 120000) {
          isWorkDetected = false;
          youtubeIdleTriggered = true;
        } else {
          // Less than 2 minutes, count as work (grace period)
          isWorkDetected = true;
        }
      }
    } else {
      // Reset YouTube timer when off YouTube
      lastYouTubeActiveTime = 0;
      youtubeIdleTriggered = false;

      // Check editing work website keywords
      const hasWorkKeyword = WORK_WEBSITE_KEYWORDS.some(kw => activeTitle.includes(kw));
      if (hasWorkKeyword) {
        isWorkDetected = true;
      }
    }
  } else {
    // If not a browser, reset YouTube timer
    lastYouTubeActiveTime = 0;
  }

  // 4. Detect Gaming
  if (GAME_PROCESS_KEYWORDS.some(kw => activeProcess.includes(kw))) {
    isGameDetected = true;
  }

  // 5. System Idle Check (No mouse/keyboard input for 2 minutes)
  const isSystemIdle = idleMs > 120000;

  // State Machine Evaluation
  if (isWorkDetected && !isSystemIdle) {
    lastWorkTime = now;
    isGaming = false;
    
    if (isIdle) {
      isIdle = false;
      console.log(`[TIMEROI Agent] State Changed: Work Resumed`);
      sendToClient({
        type: 'state-change',
        data: { state: 'working', activeProcess, activeTitle }
      });
    }

    // Auto-Start Premiere Rule: If Premiere is active, start timer on client
    if (activeProcess.includes('premiere') && !currentTrackingState.isTracking) {
      console.log(`[TIMEROI Agent] Premiere Pro active. Auto-starting active timer.`);
      sendToClient({
        type: 'auto-start-request',
        data: { process: activeProcess, title: activeTitle }
      });
    }

  } else if (isGameDetected && !isSystemIdle) {
    lastWorkTime = now; // Prevent idle trigger immediately, let gaming take over
    if (!isGaming) {
      isGaming = true;
      isIdle = false;
      console.log(`[TIMEROI Agent] State Changed: Gaming Detected (${activeProcess})`);
      sendToClient({
        type: 'state-change',
        data: { state: 'gaming', activeProcess }
      });
    }
  } else {
    // Non-work app focused, or system is idle
    const inactiveDuration = now - lastWorkTime;

    // If active duration of non-work/idle exceeds 2 minutes
    if (inactiveDuration > 120000 || isSystemIdle || youtubeIdleTriggered) {
      if (!isIdle) {
        isIdle = true;
        isGaming = false;
        console.log(`[TIMEROI Agent] State Changed: User is Idle (Inactivity for ${Math.round(inactiveDuration/1000)}s)`);
        
        // Notify client to pause and retroactively subtract the 2-minute grace period
        sendToClient({
          type: 'idle-trigger',
          data: {
            reason: isSystemIdle ? 'system_inactivity' : (youtubeIdleTriggered ? 'youtube' : 'unrelated_app'),
            durationMs: inactiveDuration,
            subtractSeconds: 120 // Retroactively pause 2 minutes ago
          }
        });
      }
    }
  }

  // Send status heartbeat to client
  sendToClient({
    type: 'heartbeat',
    data: {
      activeProcess,
      activeTitle,
      idleMs,
      state: isIdle ? 'idle' : (isGaming ? 'gaming' : 'working'),
      tracking: currentTrackingState
    }
  });
};

// Send message to the connected web app
const sendToClient = (msg) => {
  if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
    activeClientWs.send(JSON.stringify(msg));
  }
};

// Handle WebClient connections
wss.on('connection', (ws) => {
  console.log(`[TIMEROI Agent] Web Client connected successfully`);
  activeClientWs = ws;

  // Send initial handshake state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      agent: 'TIMEROI Windows Agent',
      version: '1.0.0',
      os: 'Windows'
    }
  }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      console.log(`[TIMEROI Agent] Received message:`, parsed);

      switch (parsed.type) {
        case 'timer-state-update':
          // Update agent's internal knowledge of what is currently tracking in browser
          currentTrackingState = {
            activeClientId: parsed.data.clientId,
            activeVideoId: parsed.data.videoId,
            isTracking: parsed.data.isTracking,
            lastStartTime: parsed.data.lastStartTime,
            totalSeconds: parsed.data.totalSeconds
          };
          break;
        case 'heartbeat-ack':
          // Web client acknowledged heartbeat
          break;
        default:
          console.log(`[TIMEROI Agent] Unknown message type: ${parsed.type}`);
      }
    } catch (err) {
      console.error(`[TIMEROI Agent] Error processing message:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`[TIMEROI Agent] Web Client disconnected`);
    activeClientWs = null;
  });
});

// Start the tracker process
startPowerShellTracker();
