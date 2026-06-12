const { ipcRenderer, shell } = require('electron');
const { createClient } = require('@supabase/supabase-js');

// ═══════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════

const SUPABASE_URL = 'https://bztlmidtxgqafkrkrmhf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6dGxtaWR0eGdxYWZrcmtybWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5Mzg4MjIsImV4cCI6MjA5NjUxNDgyMn0.NyomEMLbZHnDgyx8l2p4V-mVAmfWR-CbBWmCRALJ21I';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ═══════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════

let localAppDurations = {};
let currentUser = null;
let currentWorkspace = null;
let clientsList = [];
let selectedClientId = '';
let selectedVideoId = '';
let isLocalTracking = false;
let trackingStartTime = null;
let trackingAccumulatedSec = 0;
let localTimerInterval = null;
let currentLogs = [];
let dbSaveTimeout = null;
let lastFocusedProcess = '';
let currentPromptProcess = null;
let localConfig = null;
let sessionStats = { workMs: 0, gamingMs: 0, entertainmentMs: 0, idleMs: 0, focusStreakCount: 0, longestFocusStreakMs: 0, currentStreakMs: 0 };
let dailyStatsData = {};

// ═══════════════════════════════════════════
// DOM REFERENCES
// ═══════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const loginScreen = $('login-screen');
const appScreen = $('app-screen');
const loginForm = $('login-form');
const loginEmail = $('login-email');
const loginPassword = $('login-password');
const loginErrorMsg = $('login-error-msg');
const loginSubmitBtn = $('login-submit-btn');

const userEmailLbl = $('user-email-lbl');
const userAvatarLbl = $('user-avatar-lbl');
const logoutBtn = $('logout-btn');

const tabButtons = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');

const stateCardContainer = $('state-card-container');
const stateTitle = $('state-title');
const stateDesc = $('state-desc');
const stateConfidence = $('state-confidence');
const stateStreak = $('state-streak');
const stateSource = $('state-source');

const focusedAppIcon = $('focused-app-icon');
const focusedAppName = $('focused-app-name');
const focusedWindowTitle = $('focused-window-title');
const idleValue = $('idle-value');
const focusClassification = $('focus-classification');

const projectSelector = $('project-selector');
const taskSelector = $('task-selector');
const timerClock = $('timer-clock');
const timerStatus = $('timer-status');
const btnStart = $('btn-start');
const btnStop = $('btn-stop');
const btnComplete = $('btn-complete');
const syncStatusBadge = $('sync-status-badge');
const syncBtn = $('sync-btn');

const settingsForm = $('settings-form');
const workKeywordsInput = $('work-keywords');
const gameKeywordsInput = $('game-keywords');
const idleTimeInput = $('idle-time');
const idleTimeVal = $('idle-time-val');
const autoTrackingEnabledInput = $('auto-tracking-enabled');
const gamingTrackingEnabledInput = $('gaming-tracking-enabled');
const notificationsEnabledInput = $('notifications-enabled');
const breakRemindersEnabledInput = $('break-reminders-enabled');
const autoStartOnBootInput = $('auto-start-on-boot');
const startMinimizedInput = $('start-minimized');
const focusGoalInput = $('focus-goal');
const focusGoalVal = $('focus-goal-val');

const modelSharingInput = $('model-sharing-enabled');
const onlineSearchEnabledInput = $('online-search-enabled');
const githubTokenInput = $('github-token');
const modelSyncStatusText = $('model-sync-status-text');
const btnSyncNow = $('btn-sync-now');

const logsContainer = $('logs-container');
const clearLogsBtn = $('clear-logs-btn');

// ═══════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const target = btn.getAttribute('data-tab');
    const panel = $(`tab-${target}`);
    if (panel) {
      panel.classList.add('active');
      // Re-trigger fadeIn animation
      panel.style.animation = 'none';
      panel.offsetHeight; // force reflow
      panel.style.animation = '';
    }

    if (target === 'analytics') updateAnalyticsUI();
  });
});

// ═══════════════════════════════════════════
// SLIDER INPUTS
// ═══════════════════════════════════════════

idleTimeInput.addEventListener('input', (e) => {
  const seconds = parseInt(e.target.value);
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  idleTimeVal.textContent = minutes > 0 ? `${minutes}m${rem > 0 ? ` ${rem}s` : ''}` : `${seconds}s`;
});

focusGoalInput.addEventListener('input', (e) => {
  focusGoalVal.textContent = `${e.target.value}m`;
});

// ═══════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════

function appLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const logEntry = { time, message, type, timestamp: Date.now() };
  currentLogs.unshift(logEntry);
  if (currentLogs.length > 150) currentLogs.pop();
  renderLogs();
  ipcRenderer.send('manual-log-sync', logEntry);
}

function renderLogs() {
  if (currentLogs.length === 0) {
    logsContainer.innerHTML = '<div class="log-entry empty">No records yet. Monitoring system activity...</div>';
    return;
  }
  logsContainer.innerHTML = currentLogs.map(log => {
    const typeClass = log.type && log.type !== 'info' ? ` type-${log.type}` : '';
    return `<div class="log-entry${typeClass}">[${log.time}] ${log.message}</div>`;
  }).join('');
}

clearLogsBtn.addEventListener('click', () => {
  currentLogs = [];
  renderLogs();
});

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════

async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    onUserAuthenticated(session.user);
  } else {
    showLoginView();
  }
}
checkSession();

function showLoginView() {
  loginScreen.style.display = 'flex';
  appScreen.style.display = 'none';
  loginSubmitBtn.disabled = false;
  loginSubmitBtn.textContent = 'Sign In';
}

function onUserAuthenticated(user) {
  currentUser = user;
  loginScreen.style.display = 'none';
  appScreen.style.display = 'flex';

  const email = user.email || 'user@example.com';
  userEmailLbl.textContent = email;
  userAvatarLbl.textContent = email.charAt(0).toUpperCase();

  appLog(`Authenticated as: ${email}`);
  loadWorkspaceData();
  ipcRenderer.send('get-initial-state');
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErrorMsg.textContent = '';
  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Signing in...';

  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    loginErrorMsg.textContent = error.message;
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Sign In';
  } else if (data?.user) {
    onUserAuthenticated(data.user);
  }
});

logoutBtn.addEventListener('click', async () => {
  if (isLocalTracking) {
    alert('Please stop the active timer before signing out.');
    return;
  }
  appLog('Signing out');
  await supabase.auth.signOut();
  currentUser = null;
  currentWorkspace = null;
  clientsList = [];
  projectSelector.innerHTML = '<option value="">No Project Selected</option>';
  taskSelector.innerHTML = '<option value="">No Task Selected</option>';
  taskSelector.disabled = true;
  showLoginView();
});

// ═══════════════════════════════════════════
// WORKSPACE DATA
// ═══════════════════════════════════════════

async function loadWorkspaceData() {
  if (!currentUser) return;
  syncStatusBadge.textContent = 'Syncing...';
  syncStatusBadge.style.color = 'var(--yellow)';

  try {
    const { data, error } = await supabase
      .from('workspace_data')
      .select('*')
      .eq('username', currentUser.email.toLowerCase())
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        await createInitialWorkspace();
      } else {
        syncStatusBadge.textContent = 'Sync Failed';
        syncStatusBadge.style.color = 'var(--red)';
        appLog(`Cloud error: ${error.message}`, 'error');
      }
    } else if (data) {
      currentWorkspace = data;
      clientsList = data.clients || [];
      populateProjectSelector();
      syncStatusBadge.textContent = 'Cloud Active';
      syncStatusBadge.style.color = 'var(--green)';
      appLog('Workspace synced from cloud');
    }
  } catch (err) {
    syncStatusBadge.textContent = 'Offline';
    syncStatusBadge.style.color = 'var(--text-3)';
  }
}

async function createInitialWorkspace() {
  const initialData = {
    username: currentUser.email.toLowerCase(),
    theme: {},
    clients: [],
    active_client_id: null,
    archived_clients: [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from('workspace_data').insert(initialData);
  if (error) {
    console.error('Error creating workspace:', error);
  } else {
    currentWorkspace = initialData;
    clientsList = [];
    populateProjectSelector();
    syncStatusBadge.textContent = 'Cloud Active';
    syncStatusBadge.style.color = 'var(--green)';
    appLog('Initialized cloud workspace');
  }
}

// ═══════════════════════════════════════════
// PROJECT & TASK SELECTORS
// ═══════════════════════════════════════════

function populateProjectSelector() {
  const prev = selectedClientId;
  projectSelector.innerHTML = '<option value="">No Project Selected</option>';

  clientsList.forEach(client => {
    const opt = document.createElement('option');
    opt.value = client.id;
    opt.textContent = client.name;
    projectSelector.appendChild(opt);
  });

  if (prev && clientsList.some(c => c.id === prev)) {
    projectSelector.value = prev;
    populateTaskSelector();
  } else {
    selectedClientId = '';
    selectedVideoId = '';
    taskSelector.innerHTML = '<option value="">No Task Selected</option>';
    taskSelector.disabled = true;
    updateTimerButtonsState();
  }
}

function populateTaskSelector() {
  const prev = selectedVideoId;
  taskSelector.innerHTML = '<option value="">No Task Selected</option>';

  const client = clientsList.find(c => c.id === selectedClientId);
  if (client && client.videos && client.videos.length > 0) {
    taskSelector.disabled = false;
    client.videos.forEach(video => {
      const opt = document.createElement('option');
      opt.value = video.id;
      const icon = video.status === 'finished' ? '✅' : (video.status === 'started' ? '⏱️' : '⏸️');
      opt.textContent = `${icon} ${video.note || `Task #${video.id}`}`;
      taskSelector.appendChild(opt);
    });

    if (prev && client.videos.some(v => v.id.toString() === prev.toString())) {
      taskSelector.value = prev;
    } else {
      selectedVideoId = '';
    }
  } else {
    taskSelector.disabled = true;
    selectedVideoId = '';
  }

  updateTimerDisplay();
  updateTimerButtonsState();
}

projectSelector.addEventListener('change', (e) => {
  if (isLocalTracking) {
    alert('Stop the current timer before switching projects.');
    projectSelector.value = selectedClientId;
    return;
  }
  selectedClientId = e.target.value;
  selectedVideoId = '';
  populateTaskSelector();
});

taskSelector.addEventListener('change', (e) => {
  if (isLocalTracking) {
    alert('Stop the current timer before switching tasks.');
    taskSelector.value = selectedVideoId;
    return;
  }
  selectedVideoId = e.target.value;
  updateTimerDisplay();
  updateTimerButtonsState();
});

// ═══════════════════════════════════════════
// TIMER CONTROLLER
// ═══════════════════════════════════════════

function updateTimerDisplay() {
  const task = getActiveTask();
  if (task) {
    trackingAccumulatedSec = task.totalSeconds || 0;
    timerClock.textContent = formatTimerSeconds(trackingAccumulatedSec);
    timerStatus.textContent = task.status.replace('_', ' ');
    timerClock.style.color = task.status === 'started' ? 'var(--green)' : 'var(--text-1)';
  } else {
    timerClock.textContent = '00:00:00';
    timerStatus.textContent = 'Idle';
    timerClock.style.color = 'var(--text-3)';
  }
}

function updateTimerButtonsState() {
  const task = getActiveTask();
  if (!selectedVideoId || !task) {
    btnStart.disabled = true;
    btnStop.style.display = 'none';
    btnComplete.disabled = true;
    return;
  }

  if (task.status === 'started') {
    btnStart.style.display = 'none';
    btnStop.style.display = 'inline-flex';
    btnStop.disabled = false;
    btnComplete.disabled = false;
  } else {
    btnStart.style.display = 'inline-flex';
    btnStart.disabled = task.status === 'finished';
    btnStop.style.display = 'none';
    btnComplete.disabled = task.status === 'finished';
  }
}

function getActiveTask() {
  if (!selectedClientId || !selectedVideoId) return null;
  const client = clientsList.find(c => c.id === selectedClientId);
  if (!client) return null;
  return client.videos.find(v => v.id.toString() === selectedVideoId.toString()) || null;
}

btnStart.addEventListener('click', () => startTimer());
btnStop.addEventListener('click', () => stopTimer());
btnComplete.addEventListener('click', () => completeTimer());

function startTimer() {
  const task = getActiveTask();
  if (!task || isLocalTracking) return;

  appLog(`Timer started: "${task.note || `Task #${task.id}`}"`, 'auto');

  isLocalTracking = true;
  trackingStartTime = Date.now();
  trackingAccumulatedSec = task.totalSeconds || 0;

  // Minimize if creative software is focused
  const creativeApps = ['premiere', 'resolve', 'photoshop', 'aftereffects', 'illustrator', 'audition', 'lightroom', 'capcut', 'vegas', 'audacity', 'blender', 'cinema4d', 'unreal', 'unity', 'obs'];
  if (lastFocusedProcess && creativeApps.some(p => lastFocusedProcess.toLowerCase().includes(p))) {
    ipcRenderer.send('minimize-main-window');
  }

  task.status = 'started';
  task.lastStartTime = trackingStartTime;

  if (task.lastStopTime) {
    const gap = Math.floor((trackingStartTime - task.lastStopTime) / 1000);
    task.idleGaps = task.idleGaps || [];
    task.idleGaps.push(gap);
  }

  ipcRenderer.send('set-timer-tracking-state', {
    clientId: selectedClientId,
    videoId: selectedVideoId,
    isTracking: true
  });

  localTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - trackingStartTime) / 1000);
    const clockText = formatTimerSeconds(trackingAccumulatedSec + elapsed);
    timerClock.textContent = clockText;

    let stateVal = 'working';
    if (stateCardContainer.classList.contains('state-gaming')) stateVal = 'gaming';
    else if (stateCardContainer.classList.contains('state-idle')) stateVal = 'idle';

    ipcRenderer.send('timer-tick-sync', {
      clockText,
      isTracking: true,
      state: stateVal
    });

    // Live update analytics
    const analyticsPanel = $('tab-analytics');
    if (analyticsPanel && analyticsPanel.classList.contains('active')) {
      if (task) task.totalSeconds = trackingAccumulatedSec + elapsed;
      updateAnalyticsUI();
    }
  }, 1000);

  updateTimerButtonsState();
  timerStatus.textContent = 'Tracking';
  timerClock.style.color = 'var(--green)';

  saveWorkspaceToSupabase();
}

function stopTimer() {
  const task = getActiveTask();
  if (!task || !isLocalTracking) return;

  appLog(`Timer paused: "${task.note || `Task #${task.id}`}"`);

  clearInterval(localTimerInterval);
  isLocalTracking = false;

  const elapsed = Math.floor((Date.now() - trackingStartTime) / 1000);
  task.totalSeconds = (task.totalSeconds || 0) + elapsed;
  task.status = 'paused';
  task.lastStartTime = null;
  task.lastStopTime = Date.now();

  ipcRenderer.send('set-timer-tracking-state', { clientId: null, videoId: null, isTracking: false });
  ipcRenderer.send('timer-tick-sync', { clockText: timerClock.textContent, isTracking: false, state: 'working' });

  updateTimerDisplay();
  updateTimerButtonsState();
  populateTaskSelector();
  saveWorkspaceToSupabase();
}

function completeTimer() {
  const task = getActiveTask();
  if (!task) return;

  if (!confirm('Mark this task as completed?')) return;

  appLog(`Task completed: "${task.note || `Task #${task.id}`}"`, 'auto');

  if (isLocalTracking) {
    clearInterval(localTimerInterval);
    isLocalTracking = false;
    const elapsed = Math.floor((Date.now() - trackingStartTime) / 1000);
    task.totalSeconds = (task.totalSeconds || 0) + elapsed;
  }

  task.status = 'finished';
  task.lastStartTime = null;
  task.lastStopTime = Date.now();
  task.finishedCount = (task.finishedCount || 0) + 1;

  ipcRenderer.send('set-timer-tracking-state', { clientId: null, videoId: null, isTracking: false });
  ipcRenderer.send('timer-tick-sync', { clockText: '00:00:00', isTracking: false, state: 'working' });

  updateTimerDisplay();
  updateTimerButtonsState();
  populateTaskSelector();
  saveWorkspaceToSupabase();
}

// Periodic autosave while tracking
setInterval(() => {
  if (isLocalTracking) {
    const task = getActiveTask();
    if (task) {
      const elapsed = Math.floor((Date.now() - trackingStartTime) / 1000);
      task.totalSeconds = trackingAccumulatedSec + elapsed;
      saveWorkspaceToSupabase(true);
    }
  }
}, 30000);

// ═══════════════════════════════════════════
// SUPABASE SYNC
// ═══════════════════════════════════════════

async function saveWorkspaceToSupabase(isAutosave = false) {
  if (!currentUser || !currentWorkspace) return;

  syncStatusBadge.textContent = 'Saving...';
  syncStatusBadge.style.color = 'var(--yellow)';

  try {
    currentWorkspace.clients = clientsList;
    currentWorkspace.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('workspace_data')
      .upsert(currentWorkspace, { onConflict: 'username' });

    if (error) {
      syncStatusBadge.textContent = 'Sync Failed';
      syncStatusBadge.style.color = 'var(--red)';
      if (!isAutosave) appLog(`Sync failed: ${error.message}`, 'error');
    } else {
      syncStatusBadge.textContent = 'Cloud Active';
      syncStatusBadge.style.color = 'var(--green)';
      if (!isAutosave) appLog('Saved to cloud');
    }
  } catch (err) {
    syncStatusBadge.textContent = 'Offline';
    syncStatusBadge.style.color = 'var(--text-3)';
  }
}

// ═══════════════════════════════════════════
// OS EVENT HANDLERS (from main.js)
// ═══════════════════════════════════════════

ipcRenderer.on('raw-focus-update', (event, data) => {
  lastFocusedProcess = data.process;
  focusedAppName.textContent = capitalizeFirst(data.process) || 'System';
  focusedWindowTitle.textContent = data.title || 'In background';

  const idleSec = Math.floor(data.idleMs / 1000);
  idleValue.textContent = idleSec < 60 ? `${idleSec}s` : `${Math.floor(idleSec / 60)}m ${idleSec % 60}s`;
  focusClassification.textContent = data.classification || '—';

  // Update AI confidence display
  updateConfidenceDisplay(data.confidence, data.source);

  // Process duration categories while tracking
  if (isLocalTracking) {
    const task = getActiveTask();
    if (task) {
      task.processDurations = task.processDurations || { 'Creative Work': 0, 'Gaming': 0, 'Entertainment': 0, 'Discord': 0, 'Web Work': 0, 'Other': 0 };

      const procLower = (data.process || '').toLowerCase();
      const titLower = (data.title || '').toLowerCase();
      let catName = 'Other';

      const gameKeywords = gameKeywordsInput && gameKeywordsInput.value
        ? gameKeywordsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];
      const workKeywords = workKeywordsInput && workKeywordsInput.value
        ? workKeywordsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];

      const creativeApps = ['premiere', 'resolve', 'photoshop', 'aftereffects', 'illustrator', 'audition', 'lightroom', 'capcut', 'vegas', 'audacity', 'blender', 'cinema4d', 'unreal', 'unity', 'obs'];

      if (creativeApps.some(p => procLower.includes(p))) {
        catName = 'Creative Work';
      } else if (procLower.includes('discord')) {
        catName = 'Discord';
      } else if (gameKeywords.some(kw => procLower.includes(kw))) {
        catName = 'Gaming';
      } else if (['chrome', 'msedge', 'firefox', 'brave', 'opera'].some(b => procLower.includes(b))) {
        if (data.state === 'entertainment' || ['youtube', 'twitch', 'netflix', 'reddit', 'tiktok', 'instagram', 'facebook'].some(kw => titLower.includes(kw))) {
          catName = 'Entertainment';
        } else {
          catName = workKeywords.some(kw => titLower.includes(kw)) ? 'Web Work' : 'Other';
        }
      } else if (data.state === 'entertainment') {
        catName = 'Entertainment';
      }

      task.processDurations[catName] = (task.processDurations[catName] || 0) + 0.6;
    }
  }

  // App icon matching
  const creativeAppsList = ['premiere', 'resolve', 'photoshop', 'aftereffects', 'illustrator', 'audition', 'lightroom', 'capcut', 'vegas', 'audacity', 'blender', 'cinema4d', 'unreal', 'unity', 'obs'];
  const procLower = (data.process || '').toLowerCase();

  if (creativeAppsList.some(p => procLower.includes(p))) {
    focusedAppIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><polygon points="10 8 16 12 10 16 10 8"/></svg>';
    handlePremiereProjectAutoImport(parsePremiereProjectName(data.title));
  } else if (data.process === 'explorer') {
    focusedAppIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  } else if (['chrome', 'msedge', 'firefox', 'brave', 'opera'].some(b => data.process.includes(b))) {
    focusedAppIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  } else if (data.process.includes('discord')) {
    focusedAppIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  } else if (data.process.includes('spotify')) {
    focusedAppIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12c2.5-1 5.5-1 8 0"/><path d="M9 15c2-.5 4-.5 6 0"/></svg>';
  } else {
    focusedAppIcon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
  }
});

// State changes with smooth transitions
ipcRenderer.on('state-change', (event, data) => {
  const state = typeof data === 'string' ? data : data.state;
  stateCardContainer.className = 'glass-card state-hero';

  if (state === 'working') {
    stateCardContainer.classList.add('state-working');
    stateTitle.textContent = 'Working';
    stateDesc.textContent = 'Active work detected — time logged';
  } else if (state === 'idle') {
    stateCardContainer.classList.add('state-idle');
    stateTitle.textContent = 'Idle';
    stateDesc.textContent = 'Inactivity or non-work app focused';
  } else if (state === 'gaming') {
    stateCardContainer.classList.add('state-gaming');
    stateTitle.textContent = 'Gaming';
    stateDesc.textContent = 'Gaming session detected';
  } else if (state === 'entertainment') {
    stateCardContainer.classList.add('state-entertainment');
    stateTitle.textContent = 'Entertainment';
    stateDesc.textContent = 'Entertainment or media session detected';
  }

  // Enhanced data from v2 engine
  if (typeof data === 'object') {
    if (data.confidence !== undefined) stateConfidence.textContent = `${(data.confidence * 100).toFixed(0)}%`;
    if (data.focusStreak !== undefined) stateStreak.textContent = `${data.focusStreak}m`;
    if (data.source) stateSource.textContent = data.source.replace(/[-_]/g, ' ');

    // Update session ring on dashboard
    if (data.sessionWorkMs !== undefined) {
      updateSessionRing(data.sessionWorkMs, data.sessionGamingMs, data.sessionEntertainmentMs || 0, data.sessionIdleMs);
    }
  }

  // Update focus goal
  updateFocusGoal();
});

// Log updates from main
ipcRenderer.on('log-update', (event, logEntry) => {
  currentLogs.unshift(logEntry);
  if (currentLogs.length > 150) currentLogs.pop();
  renderLogs();
});

// Auto-start timer
ipcRenderer.on('auto-start-request', (event, data) => {
  const task = getActiveTask();
  if (task && task.status !== 'started' && task.status !== 'finished' && !isLocalTracking) {
    appLog(`Auto-start triggered: ${data.process}`, 'auto');
    startTimer();
  }
});

// Idle trigger
ipcRenderer.on('idle-trigger', (event, data) => {
  if (!isLocalTracking) return;

  const task = getActiveTask();
  if (!task) return;

  let reasonText = 'Inactivity';
  if (data.reason === 'youtube_distraction' || data.reason === 'youtube') reasonText = 'YouTube distraction';
  else if (data.reason === 'unrelated_app') reasonText = 'Unrelated window';

  appLog(`Idle: ${reasonText}. Subtracting ${data.subtractSeconds}s.`, 'suggestion');

  clearInterval(localTimerInterval);
  isLocalTracking = false;

  const elapsed = Math.floor((Date.now() - trackingStartTime) / 1000);
  const subtractSec = data.subtractSeconds || 120;
  const netElapsed = Math.max(0, elapsed - subtractSec);

  task.totalSeconds = (task.totalSeconds || 0) + netElapsed;
  task.status = 'paused';
  task.lastStartTime = null;
  task.lastStopTime = Date.now();

  ipcRenderer.send('set-timer-tracking-state', { clientId: null, videoId: null, isTracking: false });

  updateTimerDisplay();
  updateTimerButtonsState();
  populateTaskSelector();
  saveWorkspaceToSupabase();
});

// Overlay toggle
ipcRenderer.on('overlay-toggle-timer', () => {
  if (isLocalTracking) {
    stopTimer();
  } else {
    const task = getActiveTask();
    if (task) startTimer();
    else appLog('Cannot start: no task selected');
  }
});

// Break suggestion
ipcRenderer.on('break-suggestion', (event, data) => {
  appLog(`☕ Break suggestion: ${data.streakMinutes} minute focus streak`, 'suggestion');
});

// Prompt classify process
ipcRenderer.on('prompt-classify-process', (event, data) => {
  currentPromptProcess = data.process;
  const card = $('classifier-card');
  const name = $('classifier-process-name');
  if (card && name) {
    name.textContent = data.process;
    card.style.display = 'block';
  }
});

// Auto-stop request
ipcRenderer.on('auto-stop-request', () => {
  if (isLocalTracking) {
    stopTimer();
    appLog('Timer auto-stopped: work app closed', 'auto');
  }
});

// Web connection status
ipcRenderer.on('web-connection-status', () => {});
ipcRenderer.on('web-tracking-update', () => {});

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════

ipcRenderer.on('initial-state', (event, state) => {
  localConfig = state.config;
  workKeywordsInput.value = state.config.workKeywords.join(', ');
  gameKeywordsInput.value = state.config.gameKeywords.join(', ');
  idleTimeInput.value = state.config.idleThresholdMs / 1000;
  autoTrackingEnabledInput.checked = !!state.config.autoTrackingEnabled;
  gamingTrackingEnabledInput.checked = !!state.config.gamingTrackingEnabled;
  notificationsEnabledInput.checked = state.config.notificationsEnabled !== false;
  breakRemindersEnabledInput.checked = state.config.breakRemindersEnabled !== false;
  autoStartOnBootInput.checked = !!state.config.autoStartOnBoot;
  startMinimizedInput.checked = !!state.config.startMinimized;

  modelSharingInput.checked = state.config.modelSharingEnabled !== false;
  onlineSearchEnabledInput.checked = state.config.onlineSearchEnabled !== false;
  githubTokenInput.value = state.config.githubToken || '';

  if (state.config.focusGoalMinutes) {
    focusGoalInput.value = state.config.focusGoalMinutes;
  }

  if (state.appDurations) {
    localAppDurations = state.appDurations;
    renderAppDurations();
  }

  if (state.sessionStats) {
    sessionStats = state.sessionStats;
    updateSessionRing(sessionStats.workMs, sessionStats.gamingMs, sessionStats.entertainmentMs || 0, sessionStats.idleMs);
  }

  if (state.dailyStats) {
    dailyStatsData = state.dailyStats;
  }

  idleTimeInput.dispatchEvent(new Event('input'));
  focusGoalInput.dispatchEvent(new Event('input'));
  renderAppRules();
});

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const workKeywords = workKeywordsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
  const gameKeywords = gameKeywordsInput.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
  const idleThresholdMs = parseInt(idleTimeInput.value) * 1000;
  const focusGoalMinutes = parseInt(focusGoalInput.value);
  const modelSharingEnabled = modelSharingInput.checked;
  const onlineSearchEnabled = onlineSearchEnabledInput.checked;
  const githubToken = githubTokenInput.value.trim();

  ipcRenderer.send('update-config', {
    workKeywords,
    gameKeywords,
    idleThresholdMs,
    autoTrackingEnabled: autoTrackingEnabledInput.checked,
    gamingTrackingEnabled: gamingTrackingEnabledInput.checked,
    notificationsEnabled: notificationsEnabledInput.checked,
    breakRemindersEnabled: breakRemindersEnabledInput.checked,
    autoStartOnBoot: autoStartOnBootInput.checked,
    startMinimized: startMinimizedInput.checked,
    focusGoalMinutes,
    modelSharingEnabled,
    onlineSearchEnabled,
    githubToken
  });
});

ipcRenderer.on('config-updated', (event, config) => {
  localConfig = config;
  if (config.workKeywords) workKeywordsInput.value = config.workKeywords.join(', ');
  if (config.gameKeywords) gameKeywordsInput.value = config.gameKeywords.join(', ');
  if (config.idleThresholdMs) idleTimeInput.value = config.idleThresholdMs / 1000;
  if (config.focusGoalMinutes) {
    focusGoalInput.value = config.focusGoalMinutes;
    focusGoalVal.textContent = `${config.focusGoalMinutes}m`;
  }
  if (config.modelSharingEnabled !== undefined) modelSharingInput.checked = config.modelSharingEnabled;
  if (config.onlineSearchEnabled !== undefined) onlineSearchEnabledInput.checked = config.onlineSearchEnabled;
  if (config.githubToken !== undefined) githubTokenInput.value = config.githubToken;
  appLog('Configuration applied');
  renderAppRules();
  renderAppDurations();
  updateFocusGoal();
});

// App durations update
ipcRenderer.on('app-durations-update', (event, durations) => {
  localAppDurations = durations;
  renderAppDurations();
});

// ═══════════════════════════════════════════
// APP RULES MANAGER
// ═══════════════════════════════════════════

function renderAppRules() {
  const tbody = $('app-rules-table-body');
  if (!tbody || !localConfig || !localConfig.processClassifications) return;

  const rules = localConfig.processClassifications;
  tbody.innerHTML = Object.keys(rules).map(proc => {
    const type = rules[proc];
    const colors = { work: 'var(--green)', gaming: 'var(--red)', entertainment: 'var(--purple)', ai: 'var(--blue)', ignore: 'var(--text-3)' };
    const labels = { work: 'Work', gaming: 'Gaming', entertainment: 'Entertainment', ai: 'AI Decide', ignore: 'Ignore' };
    return `
      <tr>
        <td style="font-weight:600;color:var(--text-1)">${proc}</td>
        <td style="color:${colors[type] || 'var(--text-2)'};font-weight:700">${labels[type] || type}</td>
        <td style="text-align:center"><button class="delete-rule-btn" data-process="${proc}">✕</button></td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.delete-rule-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const proc = e.target.getAttribute('data-process');
      if (localConfig && localConfig.processClassifications) {
        const updated = { ...localConfig.processClassifications };
        delete updated[proc];
        ipcRenderer.send('update-config', { processClassifications: updated });
      }
    });
  });
}

const btnAddCustomRule = $('btn-add-custom-rule');
const customAppName = $('custom-app-name');
const customAppType = $('custom-app-type');

if (btnAddCustomRule) {
  btnAddCustomRule.addEventListener('click', () => {
    const proc = customAppName.value.trim().toLowerCase();
    const classification = customAppType.value;
    if (!proc) return;

    if (localConfig && localConfig.processClassifications) {
      const updated = { ...localConfig.processClassifications, [proc]: classification };
      ipcRenderer.send('update-config', { processClassifications: updated });
      customAppName.value = '';
    }
  });
}

// Classifier
function submitDashboardClassification(type) {
  if (currentPromptProcess) {
    ipcRenderer.send('classify-process-response', { process: currentPromptProcess, classification: type });
  }
  const card = $('classifier-card');
  if (card) card.style.display = 'none';
  currentPromptProcess = null;
}

const btnClassifyWork = $('btn-classify-work');
const btnClassifyGaming = $('btn-classify-gaming');
const btnClassifyEntertainment = $('btn-classify-entertainment');
const btnClassifyBoth = $('btn-classify-both');
const btnClassifyIgnore = $('btn-classify-ignore');
const classifierClose = $('classifier-close');

if (btnClassifyWork) btnClassifyWork.addEventListener('click', () => submitDashboardClassification('work'));
if (btnClassifyGaming) btnClassifyGaming.addEventListener('click', () => submitDashboardClassification('gaming'));
if (btnClassifyEntertainment) btnClassifyEntertainment.addEventListener('click', () => submitDashboardClassification('entertainment'));
if (btnClassifyBoth) btnClassifyBoth.addEventListener('click', () => submitDashboardClassification('ai'));
if (btnClassifyIgnore) btnClassifyIgnore.addEventListener('click', () => submitDashboardClassification('ignore'));
if (classifierClose) classifierClose.addEventListener('click', () => {
  const card = $('classifier-card');
  if (card) card.style.display = 'none';
});

// Sync button
syncBtn.addEventListener('click', () => {
  loadWorkspaceData();
  ipcRenderer.send('get-session-stats');
});

// ═══════════════════════════════════════════
// SESSION RING & FOCUS GOAL
// ═══════════════════════════════════════════

function updateSessionRing(workMs, gamingMs, entertainmentMs, idleMs) {
  const totalMs = workMs + gamingMs + entertainmentMs + idleMs;
  const totalMin = Math.floor(totalMs / 60000);
  const workMin = Math.floor(workMs / 60000);
  const gameMin = Math.floor(gamingMs / 60000);
  const entMin = Math.floor(entertainmentMs / 60000);
  const idleMin = Math.floor(idleMs / 60000);

  $('session-total').textContent = totalMin > 60 ? `${Math.floor(totalMin / 60)}h ${totalMin % 60}m` : `${totalMin}m`;
  $('ses-work').textContent = workMin > 60 ? `${Math.floor(workMin / 60)}h ${workMin % 60}m` : `${workMin}m`;
  $('ses-gaming').textContent = gameMin > 60 ? `${Math.floor(gameMin / 60)}h ${gameMin % 60}m` : `${gameMin}m`;
  if ($('ses-entertainment')) $('ses-entertainment').textContent = entMin > 60 ? `${Math.floor(entMin / 60)}h ${entMin % 60}m` : `${entMin}m`;
  $('ses-idle').textContent = idleMin > 60 ? `${Math.floor(idleMin / 60)}h ${idleMin % 60}m` : `${idleMin}m`;

  const circ = 251.2;

  if (totalMs === 0) {
    setRingSegment('session-ring-work', 0, circ, 0);
    setRingSegment('session-ring-gaming', 0, circ, 0);
    setRingSegment('session-ring-entertainment', 0, circ, 0);
    setRingSegment('session-ring-idle', 0, circ, 0);
  } else {
    const workLen = (workMs / totalMs) * circ;
    const gameLen = (gamingMs / totalMs) * circ;
    const entLen = (entertainmentMs / totalMs) * circ;
    const idleLen = (idleMs / totalMs) * circ;

    setRingSegment('session-ring-work', workLen, circ, 0);
    setRingSegment('session-ring-gaming', gameLen, circ, -workLen);
    setRingSegment('session-ring-entertainment', entLen, circ, -(workLen + gameLen));
    setRingSegment('session-ring-idle', idleLen, circ, -(workLen + gameLen + entLen));
  }
}

function setRingSegment(id, length, circ, offset) {
  const el = $(id);
  if (el) {
    el.setAttribute('stroke-dasharray', `${length} ${circ}`);
    el.setAttribute('stroke-dashoffset', `${offset}`);
  }
}

function updateFocusGoal() {
  const goalMin = localConfig?.focusGoalMinutes || 120;
  const currentWorkMin = Math.floor((sessionStats.workMs || 0) / 60000);
  const percent = Math.min(100, Math.round((currentWorkMin / goalMin) * 100));

  $('goal-percent').textContent = `${percent}%`;
  $('goal-bar-fill').style.width = `${percent}%`;
  $('goal-current').textContent = currentWorkMin > 60 ? `${Math.floor(currentWorkMin / 60)}h ${currentWorkMin % 60}m` : `${currentWorkMin}m`;
  $('goal-target').textContent = goalMin;

  // Color the percent based on progress
  const percentEl = $('goal-percent');
  if (percent >= 100) {
    percentEl.style.color = 'var(--green)';
  } else if (percent >= 50) {
    percentEl.style.color = 'var(--blue)';
  }
}

// Session stats response
ipcRenderer.on('session-stats-response', (event, stats) => {
  sessionStats = stats;
  updateSessionRing(stats.workMs, stats.gamingMs, stats.entertainmentMs || 0, stats.idleMs);
  updateFocusGoal();
});

// ═══════════════════════════════════════════
// PREMIERE AUTO-IMPORT
// ═══════════════════════════════════════════

function parsePremiereProjectName(title) {
  if (!title) return null;
  const idx = title.toLowerCase().indexOf('.prproj');
  if (idx === -1) return null;

  let before = title.substring(0, idx).replace(/\\/g, '/');
  const lastSlash = before.lastIndexOf('/');
  let name = '';
  if (lastSlash !== -1) {
    name = before.substring(lastSlash + 1);
  } else {
    const lastHyphen = before.lastIndexOf(' - ');
    name = lastHyphen !== -1 ? before.substring(lastHyphen + 3) : before.trim();
  }
  return name.trim() || null;
}

function handlePremiereProjectAutoImport(projectName) {
  if (!projectName) return;

  const activeTask = getActiveTask();
  if (isLocalTracking && activeTask && activeTask.note.toLowerCase() === projectName.toLowerCase()) return;

  appLog(`Premiere project: "${projectName}"`, 'auto');

  if (clientsList.length === 0) {
    const defaultClient = { id: 'client_' + Date.now(), name: 'Imported Tasks', role: 'video_editor', createdAt: Date.now(), videos: [] };
    clientsList.push(defaultClient);
    populateProjectSelector();
    selectedClientId = defaultClient.id;
    projectSelector.value = selectedClientId;
    populateTaskSelector();
    appLog('Created default project for auto-imports', 'auto');
  }

  if (!selectedClientId) {
    selectedClientId = clientsList[0].id;
    projectSelector.value = selectedClientId;
    populateTaskSelector();
  }

  const client = clientsList.find(c => c.id === selectedClientId);
  if (!client) return;

  let target = client.videos.find(v => v.note.toLowerCase() === projectName.toLowerCase());

  if (target) {
    if (isLocalTracking) stopTimer();
    selectedVideoId = target.id.toString();
    taskSelector.value = selectedVideoId;
    updateTimerDisplay();
    updateTimerButtonsState();
    appLog(`Auto-selected task "${target.note}"`, 'auto');
    startTimer();
  } else {
    if (isLocalTracking) stopTimer();
    const newTask = {
      id: Date.now(),
      status: 'started',
      totalSeconds: 0,
      lastStartTime: Date.now(),
      price: 0,
      note: projectName,
      sourceLink: '',
      finalLink: '',
      deadline: '',
      checklist: [],
      showOnCanvas: true,
      videoLength: ''
    };
    client.videos.push(newTask);
    selectedVideoId = newTask.id.toString();
    populateTaskSelector();
    taskSelector.value = selectedVideoId;
    startTimer();
    appLog(`Auto-created task "${projectName}"`, 'auto');
  }
}

// ═══════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════

let currentAnalyticsScope = 'current';
let currentAnalyticsTimeframe = 'all';

function formatAnalyticsDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function updateAnalyticsUI() {
  if (!clientsList || clientsList.length === 0) {
    $('analytics-table-body').innerHTML = '<tr><td colspan="6" class="table-empty">No project data available.</td></tr>';
    return;
  }

  let rawTasks = [];
  if (currentAnalyticsScope === 'current') {
    const project = clientsList.find(c => c.id === selectedClientId);
    if (project && project.videos) rawTasks = project.videos;
  } else {
    clientsList.forEach(c => { if (c.videos) rawTasks.push(...c.videos); });
  }

  const now = Date.now();
  const filteredTasks = rawTasks.filter(t => {
    if (currentAnalyticsTimeframe === 'day') {
      const limit = 24 * 60 * 60 * 1000;
      return (now - t.id) <= limit || (t.lastStopTime && (now - t.lastStopTime) <= limit);
    }
    if (currentAnalyticsTimeframe === 'week') {
      const limit = 7 * 24 * 60 * 60 * 1000;
      return (now - t.id) <= limit || (t.lastStopTime && (now - t.lastStopTime) <= limit);
    }
    if (currentAnalyticsTimeframe === 'month') {
      const limit = 30 * 24 * 60 * 60 * 1000;
      return (now - t.id) <= limit || (t.lastStopTime && (now - t.lastStopTime) <= limit);
    }
    return true;
  });

  // KPI calculations
  const totalTasks = filteredTasks.length;
  const completedTasks = filteredTasks.filter(t => t.status === 'finished').length;

  let totalWorkSec = 0, totalGameSec = 0, totalEntertainmentSec = 0, totalIdleSec = 0;
  filteredTasks.forEach(t => {
    const gaps = t.idleGaps || [];
    const taskIdle = gaps.reduce((s, g) => s + g, 0);
    const taskGaming = t.processDurations && t.processDurations['Gaming'] ? Math.floor(t.processDurations['Gaming']) : 0;
    const taskEnt = t.processDurations && t.processDurations['Entertainment'] ? Math.floor(t.processDurations['Entertainment']) : 0;
    const taskWork = Math.max(0, (t.totalSeconds || 0) - taskIdle - taskGaming - taskEnt);
    totalWorkSec += taskWork;
    totalGameSec += taskGaming;
    totalEntertainmentSec += taskEnt;
    totalIdleSec += taskIdle;
  });

  const totalOverallSec = totalWorkSec + totalGameSec + totalEntertainmentSec + totalIdleSec;
  const avgTimePerTask = completedTasks > 0 ? Math.round(totalOverallSec / completedTasks) : 0;
  const deliveryRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const idlePercentage = totalOverallSec > 0 ? Math.round((totalIdleSec / totalOverallSec) * 100) : 0;
  const gamingPercentage = totalOverallSec > 0 ? Math.round((totalGameSec / totalOverallSec) * 100) : 0;

  // Update KPI DOM
  $('stat-completed').textContent = `${completedTasks}/${totalTasks}`;
  $('stat-efficiency').textContent = `${deliveryRate}% delivery`;
  $('stat-work-time').textContent = formatAnalyticsDuration(totalWorkSec);
  $('stat-avg-time').textContent = `~${formatAnalyticsDuration(avgTimePerTask)} avg`;
  $('stat-idle-time').textContent = formatAnalyticsDuration(totalIdleSec);
  $('stat-idle-percentage').textContent = `${idlePercentage}% of total`;
  $('stat-gaming-time').textContent = formatAnalyticsDuration(totalGameSec);
  $('stat-gaming-percentage').textContent = `${gamingPercentage}% of total`;

  // Donut chart
  $('legend-work-val').textContent = formatAnalyticsDuration(totalWorkSec);
  $('legend-game-val').textContent = formatAnalyticsDuration(totalGameSec);
  if ($('legend-ent-val')) $('legend-ent-val').textContent = formatAnalyticsDuration(totalEntertainmentSec);
  $('legend-idle-val').textContent = formatAnalyticsDuration(totalIdleSec);

  const circ = 251.2;
  if (totalOverallSec === 0) {
    setRingSegment('donut-segment-working', 0, circ, 0);
    setRingSegment('donut-segment-gaming', 0, circ, 0);
    setRingSegment('donut-segment-entertainment', 0, circ, 0);
    setRingSegment('donut-segment-idle', 0, circ, 0);
    $('chart-center-value').textContent = '0m';
  } else {
    const workLen = (totalWorkSec / totalOverallSec) * circ;
    const gameLen = (totalGameSec / totalOverallSec) * circ;
    const entLen = (totalEntertainmentSec / totalOverallSec) * circ;
    const idleLen = (totalIdleSec / totalOverallSec) * circ;
    setRingSegment('donut-segment-working', workLen, circ, 0);
    setRingSegment('donut-segment-gaming', gameLen, circ, -workLen);
    setRingSegment('donut-segment-entertainment', entLen, circ, -(workLen + gameLen));
    setRingSegment('donut-segment-idle', idleLen, circ, -(workLen + gameLen + entLen));
    $('chart-center-value').textContent = formatAnalyticsDuration(totalOverallSec);
  }

  // Tasks table
  const tbody = $('analytics-table-body');
  if (filteredTasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No tasks match the filter.</td></tr>';
  } else {
    tbody.innerHTML = filteredTasks.map(t => {
      const name = t.note || `Task #${t.id}`;
      const status = t.status || 'not_started';
      const statusLabel = status === 'finished' ? 'Finished' : status === 'started' ? 'Active' : status === 'paused' ? 'Paused' : 'Pending';
      const gaps = t.idleGaps || [];
      const taskIdle = gaps.reduce((s, g) => s + g, 0);
      const taskGaming = t.processDurations && t.processDurations['Gaming'] ? Math.floor(t.processDurations['Gaming']) : 0;
      const taskEnt = t.processDurations && t.processDurations['Entertainment'] ? Math.floor(t.processDurations['Entertainment']) : 0;
      const taskWork = Math.max(0, (t.totalSeconds || 0) - taskIdle - taskGaming - taskEnt);

      return `<tr>
        <td style="font-weight:700;color:var(--text-1)">${name}</td>
        <td><span class="task-badge ${status}">${statusLabel}</span></td>
        <td style="color:var(--green);font-weight:600">${formatAnalyticsDuration(taskWork)}</td>
        <td style="color:var(--red);font-weight:600">${formatAnalyticsDuration(taskGaming)}</td>
        <td style="color:var(--purple);font-weight:600">${formatAnalyticsDuration(taskEnt)}</td>
        <td style="color:var(--yellow)">${formatAnalyticsDuration(taskIdle)}</td>
      </tr>`;
    }).join('');
  }

  // Process category bars
  const categoryTotals = { 'Creative Work': 0, 'Gaming': 0, 'Entertainment': 0, 'Discord': 0, 'Web Work': 0, 'Other': 0 };
  filteredTasks.forEach(t => {
    const durations = t.processDurations || {};
    Object.keys(categoryTotals).forEach(cat => { categoryTotals[cat] += durations[cat] || 0; });
  });

  const totalCategorySec = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
  const barsContainer = $('process-bars-container');
  if (barsContainer) {
    if (totalCategorySec === 0) {
      barsContainer.innerHTML = '<p class="table-empty">No focus data recorded yet.</p>';
    } else {
      barsContainer.innerHTML = Object.entries(categoryTotals).map(([cat, sec]) => {
        const pct = totalCategorySec > 0 ? Math.round((sec / totalCategorySec) * 100) : 0;
        const cls = cat.toLowerCase().replace(/ /g, '-');
        return `
          <div class="process-bar-row">
            <span class="process-bar-label">${cat}</span>
            <div class="process-bar-track">
              <div class="process-bar-fill ${cls}" style="width:${pct}%"></div>
            </div>
            <span class="process-bar-value">${formatAnalyticsDuration(sec)} (${pct}%)</span>
          </div>
        `;
      }).join('');
    }
  }

  // Weekly bars
  const daysOfWeek = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const dailyWorkSec = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
  const dailyGameSec = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
  const dailyEntSec = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };

  filteredTasks.forEach(t => {
    const taskDate = new Date(t.id);
    const dayIdx = taskDate.getDay();
    const dayName = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dayIdx];
    const gaps = t.idleGaps || [];
    const taskIdle = gaps.reduce((s, g) => s + g, 0);
    const taskGaming = t.processDurations && t.processDurations['Gaming'] ? Math.floor(t.processDurations['Gaming']) : 0;
    const taskEnt = t.processDurations && t.processDurations['Entertainment'] ? Math.floor(t.processDurations['Entertainment']) : 0;
    const taskWork = Math.max(0, (t.totalSeconds || 0) - taskIdle - taskGaming - taskEnt);
    dailyWorkSec[dayName] += taskWork;
    dailyGameSec[dayName] += taskGaming;
    dailyEntSec[dayName] += taskEnt;
  });

  let maxDaySec = 0;
  daysOfWeek.forEach(d => { const total = dailyWorkSec[d] + dailyGameSec[d] + dailyEntSec[d]; if (total > maxDaySec) maxDaySec = total; });

  daysOfWeek.forEach(d => {
    const workBar = $(`bar-${d}-work`);
    const gameBar = $(`bar-${d}-gaming`);
    const entBar = $(`bar-${d}-entertainment`);
    if (workBar && gameBar && entBar) {
      if (maxDaySec > 0) {
        const dayTotal = dailyWorkSec[d] + dailyGameSec[d] + dailyEntSec[d];
        const dayPct = (dayTotal / maxDaySec) * 100;
        workBar.style.height = dayTotal > 0 ? `${(dailyWorkSec[d] / dayTotal) * dayPct}%` : '0%';
        gameBar.style.height = dayTotal > 0 ? `${(dailyGameSec[d] / dayTotal) * dayPct}%` : '0%';
        entBar.style.height = dayTotal > 0 ? `${(dailyEntSec[d] / dayTotal) * dayPct}%` : '0%';
      } else {
        workBar.style.height = '0%';
        gameBar.style.height = '0%';
        entBar.style.height = '0%';
      }
    }
  });
}

function initAnalyticsEvents() {
  const btnScopeCurrent = $('btn-scope-current');
  const btnScopeAll = $('btn-scope-all');

  if (btnScopeCurrent && btnScopeAll) {
    btnScopeCurrent.addEventListener('click', () => {
      btnScopeCurrent.classList.add('active');
      btnScopeAll.classList.remove('active');
      currentAnalyticsScope = 'current';
      updateAnalyticsUI();
    });

    btnScopeAll.addEventListener('click', () => {
      btnScopeAll.classList.add('active');
      btnScopeCurrent.classList.remove('active');
      currentAnalyticsScope = 'all';
      updateAnalyticsUI();
    });
  }

  const timeBtns = document.querySelectorAll('.pill-btn[data-timeframe]');
  timeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      timeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentAnalyticsTimeframe = btn.getAttribute('data-timeframe');
      updateAnalyticsUI();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => { initAnalyticsEvents(); });
initAnalyticsEvents();

// ═══════════════════════════════════════════
// APP DURATIONS
// ═══════════════════════════════════════════

function renderAppDurations() {
  const tbody = $('app-durations-table-body');
  if (!tbody) return;

  if (!localAppDurations || Object.keys(localAppDurations).length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No app data yet.</td></tr>';
    return;
  }

  const sorted = Object.entries(localAppDurations).sort((a, b) => b[1] - a[1]);

  tbody.innerHTML = sorted.map(([proc, sec]) => {
    const classification = localConfig?.processClassifications?.[proc] || 'unclassified';
    const colors = { work: 'var(--green)', gaming: 'var(--red)', ai: 'var(--blue)', ignore: 'var(--text-3)', unclassified: 'var(--purple)' };
    const labels = { work: 'Work', gaming: 'Gaming', ai: 'AI Decide', ignore: 'Ignore', unclassified: '?' };

    return `<tr>
      <td style="font-weight:700;color:var(--text-1)">${proc}</td>
      <td>
        <select class="app-reclassify-select" data-process="${proc}">
          <option value="unclassified" ${classification === 'unclassified' ? 'selected' : ''}>? Unclassified</option>
          <option value="work" ${classification === 'work' ? 'selected' : ''}>Work</option>
          <option value="gaming" ${classification === 'gaming' ? 'selected' : ''}>Gaming</option>
          <option value="ai" ${classification === 'ai' ? 'selected' : ''}>AI Decide</option>
          <option value="ignore" ${classification === 'ignore' ? 'selected' : ''}>Ignore</option>
        </select>
      </td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--text-2)">${formatAppDurationText(sec)}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('.app-reclassify-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const proc = e.target.getAttribute('data-process');
      const val = e.target.value;
      if (localConfig?.processClassifications) {
        const updated = { ...localConfig.processClassifications };
        if (val === 'unclassified') delete updated[proc]; else updated[proc] = val;
        ipcRenderer.send('update-config', { processClassifications: updated });
      }
    });
  });
}

// ═══════════════════════════════════════════
// IN-APP TOAST NOTIFICATION SYSTEM
// Solid, visible, animated — replaces transparent native notifications
// Solid, visible, animated — replaces transparent native notifications
// ═══════════════════════════════════════════

const toastContainer = document.getElementById('toast-container');
let activeToasts = [];

function showToast({ title, body, type = 'info', duration = 4500, onClick = null }) {
  const icons = { info: '💡', success: '✅', warning: '⚠️', error: '❌' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  if (onClick) toast.style.cursor = 'pointer';
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-body">
      <span class="toast-title">${title}</span>
      <span class="toast-message">${body}</span>
    </div>
    <button class="toast-close">✕</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissToast(toast);
  });

  if (onClick) {
    toast.addEventListener('click', () => {
      onClick();
      dismissToast(toast);
    });
  }

  toastContainer.appendChild(toast);
  activeToasts.push(toast);

  // Auto dismiss
  setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.add('toast-out');
  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
    activeToasts = activeToasts.filter(t => t !== toast);
  }, 300);
}

// Listen for toast events from main process
ipcRenderer.on('show-toast', (event, data) => {
  const typeMap = {
    'info': 'info',
    'transition': 'info',
    'suggestion': 'warning',
    'auto': 'success',
    'classification': 'info',
    'error': 'error',
    'system': 'info',
    'user': 'info',
    'connection': 'info'
  };
  showToast({
    title: data.title || 'TIMEROI',
    body: data.body || '',
    type: typeMap[data.type] || 'info',
    duration: data.duration || 4500
  });
});

ipcRenderer.on('app-update-available', (event, info) => {
  appLog(`New version available: v${info.version}`, 'info');
  showToast({
    title: `TIMEROI Update Available (v${info.version})`,
    body: `${info.notes || 'A new update is ready.'}\nClick here to install it directly inside the app.`,
    type: 'success',
    duration: 15000,
    onClick: () => {
      showProgressToast(info.downloadUrl || info.url);
    }
  });
});

function showProgressToast(downloadUrl) {
  const toast = document.createElement('div');
  toast.className = 'toast toast-info';
  toast.innerHTML = `
    <div class="toast-icon">⏳</div>
    <div class="toast-body" style="width: 100%;">
      <span class="toast-title" style="display: block; font-weight: 600;">Downloading Update</span>
      <span class="toast-message" id="update-progress-text" style="display: block; margin-top: 2px;">Preparing download...</span>
      <div style="background: rgba(255, 255, 255, 0.15); height: 4px; border-radius: 2px; margin-top: 8px; overflow: hidden; width: 100%;">
        <div id="update-progress-bar" style="background: var(--blue); width: 0%; height: 100%; transition: width 0.2s ease;"></div>
      </div>
    </div>
  `;
  
  toastContainer.appendChild(toast);
  activeToasts.push(toast);
  
  ipcRenderer.send('start-update-download', downloadUrl);
  
  const progressText = toast.querySelector('#update-progress-text');
  const progressBar = toast.querySelector('#update-progress-bar');
  
  const progressListener = (event, percent) => {
    progressText.textContent = `Downloading... ${percent}%`;
    progressBar.style.width = `${percent}%`;
  };
  
  const completeListener = () => {
    progressText.textContent = 'Installing... App will restart.';
    progressBar.style.width = '100%';
    progressBar.style.background = 'var(--green)';
    ipcRenderer.removeListener('update-download-progress', progressListener);
    ipcRenderer.removeListener('update-download-complete', completeListener);
    ipcRenderer.removeListener('update-download-error', errorListener);
  };
  
  const errorListener = (event, errorMsg) => {
    progressText.textContent = `Download failed: ${errorMsg}`;
    progressBar.style.width = '100%';
    progressBar.style.background = 'var(--red)';
    ipcRenderer.removeListener('update-download-progress', progressListener);
    ipcRenderer.removeListener('update-download-complete', completeListener);
    ipcRenderer.removeListener('update-download-error', errorListener);
    
    setTimeout(() => dismissToast(toast), 6000);
  };
  
  ipcRenderer.on('update-download-progress', progressListener);
  ipcRenderer.on('update-download-complete', completeListener);
  ipcRenderer.on('update-download-error', errorListener);
}


// ═══════════════════════════════════════════
// MICRO-AI CONFIDENCE DISPLAY
// ═══════════════════════════════════════════

const focusConfidence = document.getElementById('focus-confidence');

function updateConfidenceDisplay(confidence, source) {
  if (!focusConfidence) return;
  if (confidence !== undefined && confidence !== null) {
    const pct = Math.round(confidence * 100);
    focusConfidence.textContent = `${pct}%`;
    focusConfidence.style.color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--blue)' : 'var(--yellow)';
  } else {
    focusConfidence.textContent = '—';
    focusConfidence.style.color = 'var(--purple)';
  }
}

// ═══════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════

function formatTimerSeconds(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatAppDurationText(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// Periodic session stats refresh
setInterval(() => {
  ipcRenderer.send('get-session-stats');
}, 5000);

// Model Sync Manual Controls
if (btnSyncNow) {
  btnSyncNow.addEventListener('click', () => {
    if (modelSyncStatusText) modelSyncStatusText.textContent = 'Syncing...';
    ipcRenderer.send('force-model-sync');
  });
}

ipcRenderer.on('model-sync-status', (event, { statusText, isOnline }) => {
  if (modelSyncStatusText) {
    modelSyncStatusText.textContent = statusText;
    if (isOnline) {
      modelSyncStatusText.style.color = 'var(--green)';
    } else {
      modelSyncStatusText.style.color = 'var(--text-3)';
    }
  }
});

ipcRenderer.on('focus-classifier-card', (event, { process }) => {
  // Switch to dashboard/home tab if not there
  const homeTabBtn = document.querySelector('.nav-item[data-tab="dashboard"]');
  if (homeTabBtn) homeTabBtn.click();
  // Find or highlight classifier process input
  const nameLabel = document.getElementById('classifier-process-name');
  if (nameLabel) {
    nameLabel.textContent = process;
    const card = document.getElementById('classifier-card');
    if (card) {
      card.style.display = 'block';
      card.scrollIntoView({ behavior: 'smooth' });
    }
  }
});
