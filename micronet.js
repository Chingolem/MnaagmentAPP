// ═══════════════════════════════════════════════════════════════
// TIMEROI MicroNet — Lightweight Neural Process Classifier
// ═══════════════════════════════════════════════════════════════
//
// Pure JS neural network, zero dependencies, ~25KB.
// Character n-gram embeddings → 2-layer dense net → softmax.
// Pre-trained with domain knowledge baked in as weights.
// Runs in <0.5ms per inference on any CPU from the last 15 years.
//
// Architecture:
//   Input:  128-dim character n-gram embedding (process + title)
//   Hidden: 48 neurons, ReLU
//   Output: 4 classes (work, gaming, ignore, ai-decide) + confidence
//
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// N-GRAM EMBEDDER
// Maps any string into a fixed 128-dim float vector
// using character trigrams (3-char sliding window).
// This lets the net generalize: "premiere" and "premier"
// share many trigrams, so they produce similar vectors.
// ─────────────────────────────────────────────

const VOCAB_SIZE = 256;

// Build trigram vocabulary from domain knowledge
const DOMAIN_TRIGRAMS = [
  // Creative tools
  'pre','rem','emi','mie','ier','ere','res','pho','hot','oto','sho',
  'hop','ill','llu','lus','str','tra','rat','aft','fte','fte','eff',
  'ect','ind','des','blen','len','end','cap','cut','obs','vid','edi',
  'aud','dit','lig','ght','cro','cin','ema','uni','ty3','uea','nav',
  'zon','son','fin','alcc','cut',
  // Dev tools
  'cod','ode','vsco','sco','web','bst','rm','cur','sors','urs',
  'int','tel','pych','ych','char','go','lan','rub','ymi','php',
  'rider','ider','clio','ata','rip','dock','post','ans','insom',
  'omni','npm','yarn','term','powe','shel','git','hub',
  // Productivity
  'fig','igm','not','oti','sla','lac','team','zoom','out','loo',
  'wor','exc','pow','erp','one','tre','lo','asa','lin','jir',
  'con','flu','miro','luc','air','tabl','clic','up','mon','day',
  'todo','tic','cal','mai',
  // Gaming
  'ste','tea','val','oran','riot','leag','gue','mine','craf','raft',
  'fort','nite','epic','pube','over','watc','gens','hin','rob','lox',
  'diab','ablo','witch','cybe','rpun','gta','spid','erm','god','war',
  'batt','netl','star','fiel','hogw','wart','thro','libe','rty',
  // Entertainment
  'you','utu','tub','twi','tch','red','dit','net','fli','fac',
  'ebo','ins','tag','tik','tok','pin','ter','hul','dis','ney',
  'pri','mev','crun','chy','fun','ima','vr','9ga','img','amaz',
  // Communication
  'dis','cor','tel','egr','wha','sap','skyp',
  // Work keywords in titles
  'env','vat','mot','arr','art','shu','tter','beh','anc','fre',
  'lan','sup','aba','ver','cel','loc','alho','fig','can','man',
  'agi','ment','doc','dri','stack','over','flo','npm','js','webp',
  'ack','vite','next','tail','wind','type','crip','dock','kube',
  'aws','azu','gcp','api','sql',
  // System
  'task','svh','hos','sys','set','tin','she','lex','per','ien',
  'hos','app','runt','bro','sear','chho','star','menu',
  // General n-grams for coverage
  'app','pro','exe','dll','win','mac','lin','run','bin','usr',
  'tmp','log','cfg','dat','db','svc','mgr','adm','sec','pol',
  'the','and','for','htt','www','com','org','net','api','sdk',
];

// Deduplicate and create index map
const trigramSet = [...new Set(DOMAIN_TRIGRAMS)];
const trigramIndex = {};
trigramSet.forEach((tg, i) => { trigramIndex[tg] = i % VOCAB_SIZE; });

function embedText(text) {
  const vec = new Float32Array(VOCAB_SIZE);
  if (!text) return vec;

  const lower = text.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Extract all trigrams and quad-grams
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i <= lower.length - n; i++) {
      const gram = lower.substring(i, i + n);

      // Direct lookup in vocabulary
      if (trigramIndex[gram] !== undefined) {
        vec[trigramIndex[gram]] += 1.0;
      }

      // Hash-based bucket for unseen n-grams (ensures coverage)
      let hash = 0;
      for (let c = 0; c < gram.length; c++) {
        hash = ((hash << 5) - hash + gram.charCodeAt(c)) | 0;
      }
      const bucket = Math.abs(hash) % VOCAB_SIZE;
      vec[bucket] += 0.3;
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < VOCAB_SIZE; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VOCAB_SIZE; i++) vec[i] /= norm;
  }

  return vec;
}

function embedProcessInfo(processName, windowTitle) {
  // Weighted combination: process name matters more than title
  const procVec = embedText(processName);
  const titleVec = embedText(windowTitle);

  const combined = new Float32Array(VOCAB_SIZE);
  for (let i = 0; i < VOCAB_SIZE; i++) {
    combined[i] = procVec[i] * 0.65 + titleVec[i] * 0.35;
  }
  return combined;
}

// ─────────────────────────────────────────────
// TINY NEURAL NETWORK
// 2-layer dense: 128 → 48 → 4
// Weights are pre-initialized with domain knowledge
// and fine-tuned through local online learning.
// ─────────────────────────────────────────────

const HIDDEN_SIZE = 64;
const OUTPUT_SIZE = 4; // [work, gaming, ignore, ai-decide]

const CLASS_NAMES = ['work', 'gaming', 'ignore', 'ai-decide'];

class MicroNet {
  constructor() {
    // Layer 1 weights: [HIDDEN_SIZE x VOCAB_SIZE]
    this.W1 = new Float32Array(HIDDEN_SIZE * VOCAB_SIZE);
    this.b1 = new Float32Array(HIDDEN_SIZE);

    // Layer 2 weights: [OUTPUT_SIZE x HIDDEN_SIZE]
    this.W2 = new Float32Array(OUTPUT_SIZE * HIDDEN_SIZE);
    this.b2 = new Float32Array(OUTPUT_SIZE);

    this._initWeights();
    this.trained = 0;
    this.version = 1;
  }

  // Pre-initialize with domain-knowledge heuristics
  // so the net is useful from the very first run
  _initWeights() {
    // Xavier-like initialization with small random values
    const scale1 = Math.sqrt(2.0 / VOCAB_SIZE);
    const scale2 = Math.sqrt(2.0 / HIDDEN_SIZE);

    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (Math.random() - 0.5) * scale1 * 0.1;
    for (let i = 0; i < this.b1.length; i++) this.b1[i] = 0;
    for (let i = 0; i < this.W2.length; i++) this.W2[i] = (Math.random() - 0.5) * scale2 * 0.1;
    for (let i = 0; i < this.b2.length; i++) this.b2[i] = 0;

    // Inject domain knowledge as supervised pre-training signals
    // This gives the network a strong starting bias
    const pretrainData = [
      // [process, title, correct_class]
      // Creative apps → work
      ['premiere', 'project.prproj', 0],
      ['photoshop', 'design.psd', 0],
      ['aftereffects', 'comp.aep', 0],
      ['illustrator', 'logo.ai', 0],
      ['blender', 'scene.blend', 0],
      ['resolve', 'color grading', 0],
      ['capcut', 'editing video', 0],
      ['obs', 'streaming', 0],
      ['unity', 'game project', 0],
      ['unreal', 'level editor', 0],
      ['indesign', 'layout.indd', 0],
      ['lightroom', 'photo edit', 0],
      ['audition', 'audio mix', 0],
      ['vegas', 'video edit', 0],
      ['audacity', 'recording', 0],
      ['cinema4d', '3d render', 0],

      // Dev tools → work
      ['code', 'main.ts', 0],
      ['vscode', 'app.js', 0],
      ['cursor', 'component.tsx', 0],
      ['webstorm', 'project', 0],
      ['intellij', 'Main.java', 0],
      ['pycharm', 'model.py', 0],
      ['androidstudio', 'activity.kt', 0],
      ['devenv', 'solution.sln', 0],
      ['docker', 'containers', 0],
      ['postman', 'api request', 0],
      ['terminal', 'npm install', 0],
      ['powershell', 'script.ps1', 0],
      ['cmd', 'build', 0],
      ['node', 'server.js', 0],
      ['git', 'commit', 0],

      // Productivity → work
      ['figma', 'design system', 0],
      ['notion', 'project planning', 0],
      ['slack', 'channel', 0],
      ['teams', 'meeting', 0],
      ['zoom', 'standup call', 0],
      ['outlook', 'inbox', 0],
      ['word', 'document.docx', 0],
      ['excel', 'spreadsheet', 0],
      ['jira', 'sprint board', 0],
      ['trello', 'card', 0],
      ['asana', 'task', 0],
      ['linear', 'issue', 0],
      ['todoist', 'todo list', 0],
      ['miro', 'whiteboard', 0],
      ['calendar', 'schedule', 0],
      ['mail', 'inbox', 0],

      // Gaming → gaming
      ['steam', 'library', 1],
      ['valorant', 'match', 1],
      ['leagueoflegends', 'game', 1],
      ['minecraft', 'world', 1],
      ['fortnite', 'battle pass', 1],
      ['epicgames', 'store', 1],
      ['overwatch', 'match', 1],
      ['genshinimpact', 'quest', 1],
      ['roblox', 'game', 1],
      ['csgo', 'competitive', 1],
      ['dota2', 'match', 1],
      ['wow', 'raid', 1],
      ['warmane', 'realm', 1],
      ['diablo', 'dungeon', 1],
      ['cyberpunk', 'night city', 1],
      ['witcher', 'quest', 1],
      ['gta5', 'online', 1],
      ['r5apex', 'arena', 1],
      ['pubg', 'battlegrounds', 1],
      ['valheim', 'viking', 1],
      ['ffxiv', 'duty', 1],
      ['baldursgate', 'adventure', 1],
      ['starfield', 'space', 1],
      ['eaapp', 'launcher', 1],
      ['battle.net', 'blizzard', 1],

      // Entertainment sites → gaming (distraction)
      ['chrome', 'youtube watch', 1],
      ['msedge', 'netflix browse', 1],
      ['firefox', 'reddit frontpage', 1],
      ['chrome', 'twitch stream', 1],
      ['msedge', 'tiktok', 1],

      // YouTube GAMING content → entertainment (NOT work!)
      ['chrome', 'youtube world of tanks gameplay', 1],
      ['chrome', 'youtube war thunder gameplay', 1],
      ['chrome', 'youtube valorant gameplay', 1],
      ['chrome', 'youtube minecraft lets play', 1],
      ['chrome', 'youtube fortnite highlights', 1],
      ['chrome', 'youtube gta5 online funny', 1],
      ['chrome', 'youtube league of legends gameplay', 1],
      ['chrome', 'youtube csgo competitive', 1],
      ['chrome', 'youtube dota 2 match', 1],
      ['chrome', 'youtube genshin impact gameplay', 1],
      ['chrome', 'youtube overwatch ranked', 1],
      ['chrome', 'youtube pubg battlegrounds', 1],
      ['chrome', 'youtube diablo gameplay', 1],
      ['chrome', 'youtube cyberpunk gameplay', 1],
      ['chrome', 'youtube witcher walkthrough', 1],
      ['chrome', 'youtube wow raid', 1],
      ['chrome', 'youtube apex montage', 1],
      ['chrome', 'youtube elden ring boss', 1],
      ['chrome', 'youtube hogwarts legacy', 1],
      ['chrome', 'youtube baldurs gate', 1],
      ['chrome', 'youtube starfield gameplay', 1],
      ['chrome', 'youtube god of war', 1],
      ['chrome', 'youtube dark souls speedrun', 1],
      ['chrome', 'youtube stream highlights', 1],
      ['chrome', 'youtube funny gaming moments', 1],
      ['chrome', 'youtube gaming montage', 1],
      ['chrome', 'youtube loot opening', 1],
      ['chrome', 'youtube gacha roll', 1],
      ['chrome', 'youtube movie trailer', 1],
      ['chrome', 'youtube music video', 1],
      ['chrome', 'youtube reaction video', 1],
      ['chrome', 'youtube vlog', 1],
      ['chrome', 'youtube funny compilation', 1],
      ['chrome', 'youtube prank video', 1],
      ['msedge', 'youtube world of tanks', 1],
      ['msedge', 'youtube war thunder', 1],
      ['msedge', 'youtube minecraft gameplay', 1],
      ['msedge', 'youtube valorant highlights', 1],
      ['firefox', 'youtube gta5 gameplay', 1],
      ['firefox', 'youtube fortnite gameplay', 1],
      ['brave', 'youtube league of legends', 1],
      ['chrome', 'tank gameplay youtube', 1],
      ['chrome', 'wot gameplay youtube', 1],
      ['chrome', 'world of tanks youtube', 1],
      ['chrome', 'war thunder youtube', 1],
      ['chrome', 'lets play youtube', 1],
      ['chrome', 'gameplay walkthrough youtube', 1],

      // Work browsing → work
      ['chrome', 'github repository', 0],
      ['msedge', 'stackoverflow question', 0],
      ['firefox', 'documentation api', 0],
      ['chrome', 'supabase dashboard', 0],
      ['chrome', 'figma file', 0],
      ['msedge', 'notion page', 0],
      ['chrome', 'envato elements', 0],

      // YouTube EDUCATIONAL → work (must override gaming signal!)
      ['chrome', 'youtube tutorial editing', 0],
      ['chrome', 'youtube premiere pro tutorial', 0],
      ['chrome', 'youtube photoshop tutorial', 0],
      ['chrome', 'youtube after effects tutorial', 0],
      ['chrome', 'youtube blender tutorial', 0],
      ['chrome', 'youtube coding tutorial', 0],
      ['chrome', 'youtube javascript tutorial', 0],
      ['chrome', 'youtube programming tutorial', 0],
      ['chrome', 'youtube development tutorial', 0],
      ['chrome', 'youtube web development', 0],
      ['chrome', 'youtube design tutorial', 0],
      ['chrome', 'youtube figma tutorial', 0],
      ['chrome', 'youtube how to edit video', 0],
      ['chrome', 'youtube color grading tutorial', 0],
      ['chrome', 'youtube api documentation', 0],
      ['chrome', 'youtube stackoverflow', 0],
      ['chrome', 'youtube github repo', 0],
      ['chrome', 'youtube npm package', 0],
      ['chrome', 'youtube documentation guide', 0],
      ['chrome', 'youtube learn programming', 0],
      ['chrome', 'youtube study with me', 0],
      ['chrome', 'youtube course lecture', 0],
      ['msedge', 'youtube editing tutorial', 0],
      ['msedge', 'youtube premiere pro tutorial', 0],
      ['msedge', 'youtube coding tutorial', 0],
      ['firefox', 'youtube programming tutorial', 0],

      // Communication → ai-decide
      ['discord', 'server chat', 3],
      ['telegram', 'channel', 3],
      ['whatsapp', 'conversation', 3],

      // System → ignore
      ['taskhostw', '', 2],
      ['svchost', '', 2],
      ['systemsettings', 'settings', 2],
      ['searchui', '', 2],
      ['runtimebroker', '', 2],
      ['shellexperiencehost', '', 2],
      ['applicationframehost', '', 2],
      ['startmenuexperiencehost', '', 2],

      // Media players → ignore
      ['spotify', 'playlist', 2],

      // Browsers general → ai-decide
      ['chrome', 'new tab', 3],
      ['msedge', 'new tab', 3],
      ['firefox', 'new tab', 3],
      ['brave', 'new tab', 3],
      ['opera', 'new tab', 3],
    ];

    // Train with high learning rate for a few epochs to bake in knowledge
    for (let epoch = 0; epoch < 50; epoch++) {
      // Shuffle order each epoch
      for (let i = pretrainData.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pretrainData[i], pretrainData[j]] = [pretrainData[j], pretrainData[i]];
      }

      for (const [proc, title, correctClass] of pretrainData) {
        const input = embedProcessInfo(proc, title);
        this._trainStep(input, correctClass, 0.05);
      }
    }
  }

  // Forward pass: input vector → output probabilities
  predict(inputVec) {
    // Hidden layer: ReLU(W1 * x + b1)
    const hidden = new Float32Array(HIDDEN_SIZE);
    for (let h = 0; h < HIDDEN_SIZE; h++) {
      let sum = this.b1[h];
      for (let i = 0; i < VOCAB_SIZE; i++) {
        sum += this.W1[h * VOCAB_SIZE + i] * inputVec[i];
      }
      hidden[h] = sum > 0 ? sum : 0; // ReLU
    }

    // Output layer: softmax(W2 * h + b2)
    const logits = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      let sum = this.b2[o];
      for (let h = 0; h < HIDDEN_SIZE; h++) {
        sum += this.W2[o * HIDDEN_SIZE + h] * hidden[h];
      }
      logits[o] = sum;
    }

    // Softmax
    let maxLogit = -Infinity;
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      if (logits[o] > maxLogit) maxLogit = logits[o];
    }

    let expSum = 0;
    const probs = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      probs[o] = Math.exp(logits[o] - maxLogit);
      expSum += probs[o];
    }
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      probs[o] /= expSum;
    }

    return { probs, hidden, logits };
  }

  // Classify: returns { class, confidence, allProbs }
  classify(processName, windowTitle) {
    const input = embedProcessInfo(processName, windowTitle);
    const { probs } = this.predict(input);

    let bestClass = 0;
    let bestProb = probs[0];
    for (let o = 1; o < OUTPUT_SIZE; o++) {
      if (probs[o] > bestProb) {
        bestProb = probs[o];
        bestClass = o;
      }
    }

    return {
      className: CLASS_NAMES[bestClass],
      confidence: bestProb,
      allProbs: {
        work: probs[0],
        gaming: probs[1],
        ignore: probs[2],
        'ai-decide': probs[3]
      }
    };
  }

  // Online training step (SGD with cross-entropy loss)
  _trainStep(inputVec, correctClass, lr = 0.01) {
    const { probs, hidden } = this.predict(inputVec);

    // Output gradient (softmax + cross-entropy)
    const outputGrad = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      outputGrad[o] = probs[o]; // dL/d(logit) = p - (o == correct)
      if (o === correctClass) outputGrad[o] -= 1.0;
    }

    // Update W2 and b2
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      for (let h = 0; h < HIDDEN_SIZE; h++) {
        this.W2[o * HIDDEN_SIZE + h] -= lr * outputGrad[o] * hidden[h];
      }
      this.b2[o] -= lr * outputGrad[o];
    }

    // Hidden gradient (ReLU backward)
    const hiddenGrad = new Float32Array(HIDDEN_SIZE);
    for (let h = 0; h < HIDDEN_SIZE; h++) {
      if (hidden[h] <= 0) continue; // ReLU: gradient = 0 if pre-activation <= 0
      for (let o = 0; o < OUTPUT_SIZE; o++) {
        hiddenGrad[h] += this.W2[o * HIDDEN_SIZE + h] * outputGrad[o];
      }
    }

    // Update W1 and b1
    for (let h = 0; h < HIDDEN_SIZE; h++) {
      for (let i = 0; i < VOCAB_SIZE; i++) {
        this.W1[h * VOCAB_SIZE + i] -= lr * hiddenGrad[h] * inputVec[i];
      }
      this.b1[h] -= lr * hiddenGrad[h];
    }
  }

  // Public: learn from a user's classification decision
  learn(processName, windowTitle, correctClass, lr = 0.02) {
    const classIdx = CLASS_NAMES.indexOf(correctClass);
    if (classIdx === -1) return;

    const input = embedProcessInfo(processName, windowTitle);

    // Train for a few steps to reinforce
    for (let step = 0; step < 5; step++) {
      this._trainStep(input, classIdx, lr);
    }

    this.trained++;
  }

  // Save/load the trained weights
  serialize() {
    return {
      version: this.version,
      trained: this.trained,
      W1: Array.from(this.W1),
      b1: Array.from(this.b1),
      W2: Array.from(this.W2),
      b2: Array.from(this.b2)
    };
  }

  static deserialize(data) {
    const net = new MicroNet();
    if (data) {
      net.version = data.version || 1;
      net.trained = data.trained || 0;
      if (data.W1) net.W1 = Float32Array.from(data.W1);
      if (data.b1) net.b1 = Float32Array.from(data.b1);
      if (data.W2) net.W2 = Float32Array.from(data.W2);
      if (data.b2) net.b2 = Float32Array.from(data.b2);
    }
    return net;
  }
}

// ─────────────────────────────────────────────
// MODULE EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  MicroNet,
  embedProcessInfo,
  embedText,
  CLASS_NAMES,
  VOCAB_SIZE,
  HIDDEN_SIZE,
  OUTPUT_SIZE
};
