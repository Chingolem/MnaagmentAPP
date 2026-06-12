// ═══════════════════════════════════════════════════════════════
// TIMEROI MicroNet Extended — Deeper Neural Network
// ═══════════════════════════════════════════════════════════════
//
// For machines that can handle it — a 3-layer network with
// 256-dim embeddings and 96-neuron hidden layers.
// ~2MB serialized, still <1ms inference, much richer feature space.
//
// The app auto-detects which version to use based on available RAM.
// This module is OPTIONAL — if it fails to load, the lightweight
// MicroNet from micronet.js is used instead.
//
// Architecture:
//   Input:  256-dim character n-gram + positional + category embeddings
//   H1:     96 neurons, ReLU
//   H2:     64 neurons, ReLU
//   Output: 4 classes (work, gaming, ignore, ai-decide) + confidence
//
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const VOCAB_SIZE_X = 256;
const H1_SIZE = 96;
const H2_SIZE = 64;
const OUTPUT_SIZE = 4;

const CLASS_NAMES = ['work', 'gaming', 'ignore', 'ai-decide'];

// ─────────────────────────────────────────────
// ENHANCED EMBEDDER — 256 dimensions
// Uses n-grams (2,3,4,5-grams), positional hashing,
// and category-aware encoding for richer representations.
// ─────────────────────────────────────────────

// Expanded vocabulary from domain knowledge
const DOMAIN_NGRAMS = [
  // Creative (weight: these fire strongly for work class)
  'prem','remi','emie','mier','iere','eres','phot','hote','otos','tosh',
  'shoo','hop','ills','lust','stra','traa','afte','ftef','effe','ffec',
  'inde','ndes','blen','lend','capc','apcu','obs6','bs64','vide','ideo',
  'edit','diti','ligh','ight','ligh','cinem','inem','unit','nity','uea',
  'navi','avig','sona','onar','fina','inal','alcu','alcc',
  // Dev tools
  'vsco','scode','webs','bsto','curs','urso','inte','ntel','pych','ycha',
  'char','gola','gola','ruby','ubym','mine','phps','hpst','ride','ider',
  'clio','liod','data','grip','rip','dock','ocke','post','ostm','anso',
  'nsom','somm','npm','yarn','term','ermi','powe','owsh','shel','hell',
  'git','gith','hub',
  // Productivity
  'figm','igma','noti','otio','slac','lack','team','eams','zoom','outl',
  'outl','loou','word','word','exce','xcel','powe','ower','poin','trre',
  'ello','asaa','asna','line','inea','jira','jira','conf','onfl','miro',
  'miro','luci','ucid','airt','irta','clic','lick','mon','mday','todo',
  'odoi','tick','ick','cale','alen','mail',
  // Gaming
  'stee','team','valo','oran','riot','leag','eagu','mine','inec','craf',
  'raft','fort','orni','nite','epic','picg','pube','ubg','over','over',
  'watc','atch','gens','ensh','inim','pact','robl','oblo','diab','iabl',
  'ablo','witc','itche','cybe','berp','rpun','gta5','spid','pide','rmam',
  'god','odof','warr','batt','attl','netl','star','tarf','fiel','ield',
  'hogw','ogwa','wart','thro','hron','libe','iber','rty',
  // Entertainment
  'yout','outu','tube','twit','witc','tch','redd','eddi','netf','etfl',
  'face','aceb','book','inst','nsta','tagr','tikto','ikt','pint','inte',
  'hulu','disn','isne','prim','rime','crun','runc','func','funi','imgu',
  '9gag','amaz',
  // Communication
  'disc','isco','cord','tele','eleg','gram','what','hats','sap','skyp',
  // Work keywords
  'enva','nvat','moti','otio','arr','rtli','shut','utte','beh','ehan',
  'supa','basa','verc','loca','alho','gman','docu','dri','stac','tack',
  'over','verf','npmj','webp','ack','vite','next','tail','wind','type',
  'crip','dock','kube','awsa','azur','gcp',
  // System
  'task','svch','chos','syss','sett','shel','lexp','perie','runt','time',
  'brok','sear','chho','star','menu','host',
  // Media
  'spot','poti','tify','play','list',
  // Common suffixes/patterns
  '.exe','.prproj','.psd','.ai','.aep','.indd','.blend','.tsx','.jsx',
  '.py','.java','.cpp','.js','.ts','.html','.css','.json','.md',
  '64','32','helper','launch','update','service','broker','manager',
  'widget','tray','splash','loader','renderer','worker','daemon',
];

const ngramIndexX = {};
[...new Set(DOMAIN_NGRAMS)].forEach((ng, i) => { ngramIndexX[ng] = i % VOCAB_SIZE_X; });

function embedTextX(text) {
  const vec = new Float32Array(VOCAB_SIZE_X);
  if (!text) return vec;

  const lower = text.toLowerCase().replace(/[^a-z0-9.]/g, '');

  // Multi-scale n-grams (2 through 5)
  for (let n = 2; n <= 5; n++) {
    for (let i = 0; i <= lower.length - n; i++) {
      const gram = lower.substring(i, i + n);

      // Direct vocabulary match
      if (ngramIndexX[gram] !== undefined) {
        vec[ngramIndexX[gram]] += (1.0 + n * 0.15); // longer matches matter more
      }

      // Hash bucket for unseen n-grams
      let hash = 0;
      for (let c = 0; c < gram.length; c++) {
        hash = ((hash << 5) - hash + gram.charCodeAt(c)) | 0;
      }
      const bucket = Math.abs(hash) % VOCAB_SIZE_X;
      vec[bucket] += 0.25;
    }
  }

  // Positional encoding: first 3 chars get extra weight
  // (apps are often identified by their prefix: "prem" → premiere)
  for (let i = 0; i < Math.min(6, lower.length); i++) {
    const posHash = (lower.charCodeAt(i) * (i + 1)) % VOCAB_SIZE_X;
    vec[Math.abs(posHash)] += 0.5 * (1 - i * 0.1);
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < VOCAB_SIZE_X; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VOCAB_SIZE_X; i++) vec[i] /= norm;
  }

  return vec;
}

function embedProcessInfoX(processName, windowTitle) {
  const procVec = embedTextX(processName);
  const titleVec = embedTextX(windowTitle);

  const combined = new Float32Array(VOCAB_SIZE_X);
  for (let i = 0; i < VOCAB_SIZE_X; i++) {
    combined[i] = procVec[i] * 0.7 + titleVec[i] * 0.3;
  }
  return combined;
}

// ─────────────────────────────────────────────
// 3-LAYER NEURAL NETWORK
// 256 → 96 → 64 → 4
// ─────────────────────────────────────────────

class MicroNetExtended {
  constructor() {
    this.W1 = new Float32Array(H1_SIZE * VOCAB_SIZE_X);
    this.b1 = new Float32Array(H1_SIZE);
    this.W2 = new Float32Array(H2_SIZE * H1_SIZE);
    this.b2 = new Float32Array(H2_SIZE);
    this.W3 = new Float32Array(OUTPUT_SIZE * H2_SIZE);
    this.b3 = new Float32Array(OUTPUT_SIZE);

    this._initWeights();
    this.trained = 0;
    this.version = 2;
  }

  _initWeights() {
    const s1 = Math.sqrt(2.0 / VOCAB_SIZE_X) * 0.15;
    const s2 = Math.sqrt(2.0 / H1_SIZE) * 0.2;
    const s3 = Math.sqrt(2.0 / H2_SIZE) * 0.25;

    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (Math.random() - 0.5) * s1;
    for (let i = 0; i < this.b1.length; i++) this.b1[i] = 0;
    for (let i = 0; i < this.W2.length; i++) this.W2[i] = (Math.random() - 0.5) * s2;
    for (let i = 0; i < this.b2.length; i++) this.b2[i] = 0;
    for (let i = 0; i < this.W3.length; i++) this.W3[i] = (Math.random() - 0.5) * s3;
    for (let i = 0; i < this.b3.length; i++) this.b3[i] = 0;

    // Pre-train with domain knowledge — balanced batches
    const pretrainData = this._getPretrainData();

    // Balance: equal samples per class per epoch
    const byClass = [[], [], [], []]; // work, gaming, ignore, ai-decide
    for (const item of pretrainData) byClass[item[2]].push(item);
    const minClass = Math.min(...byClass.map(c => c.length));

    for (let epoch = 0; epoch < 60; epoch++) {
      // Sample equally from each class
      const batch = [];
      for (let cls = 0; cls < 4; cls++) {
        const pool = byClass[cls];
        for (let i = 0; i < minClass; i++) {
          batch.push(pool[i % pool.length]);
        }
        // Shuffle class pool each epoch for variety
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
      }
      // Shuffle entire batch
      for (let i = batch.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
      const lr = epoch < 20 ? 0.05 : epoch < 40 ? 0.02 : 0.01;
      for (const [proc, title, cls] of batch) {
        this._trainStep(embedProcessInfoX(proc, title), cls, lr);
      }
    }
  }

  _getPretrainData() {
    // Extensive pre-training data — 200+ examples
    const data = [
      // Creative → work
      ['premiere', 'project.prproj', 0], ['premiere', 'sequence edit', 0],
      ['photoshop', 'design.psd', 0], ['photoshop', 'layer mask', 0],
      ['aftereffects', 'comp.aep', 0], ['aftereffects', 'motion graphics', 0],
      ['illustrator', 'logo.ai', 0], ['illustrator', 'vector art', 0],
      ['blender', 'scene.blend', 0], ['blender', '3d modeling', 0],
      ['resolve', 'color grading', 0], ['resolve', 'davinci resolve', 0],
      ['capcut', 'editing video', 0], ['obs64', 'streaming setup', 0],
      ['obs', 'recording', 0], ['unity', 'game project', 0],
      ['unreal', 'level editor', 0], ['indesign', 'layout.indd', 0],
      ['lightroom', 'photo edit', 0], ['audition', 'audio mix', 0],
      ['vegas', 'video edit', 0], ['audacity', 'recording', 0],
      ['cinema4d', '3d render', 0], ['finalcut', 'timeline', 0],
      ['hitfilm', 'vfx composite', 0], ['nuke', 'compositing', 0],
      ['houdini', 'procedural', 0], ['zbrush', 'sculpting', 0],
      ['substance', 'texture paint', 0], ['filmora', 'video editing', 0],
      ['kinemaster', 'mobile edit', 0], ['davinci', 'color page', 0],

      // Dev → work
      ['code', 'main.ts', 0], ['vscode', 'app.js', 0],
      ['vscode', 'component.tsx', 0], ['cursor', 'ai coding', 0],
      ['webstorm', 'project', 0], ['intellij', 'Main.java', 0],
      ['pycharm', 'model.py', 0], ['goland', 'main.go', 0],
      ['androidstudio', 'activity.kt', 0], ['devenv', 'solution.sln', 0],
      ['docker', 'containers', 0], ['postman', 'api request', 0],
      ['terminal', 'npm install', 0], ['powershell', 'script.ps1', 0],
      ['cmd', 'build output', 0], ['node', 'server.js', 0],
      ['git', 'commit changes', 0], ['insomnia', 'rest api', 0],
      ['rider', 'csharp project', 0], ['clion', 'cmake', 0],
      ['datagrip', 'sql query', 0], ['warp', 'terminal', 0],
      ['hyper', 'zsh shell', 0], ['iterm', 'ssh session', 0],

      // Productivity → work
      ['figma', 'design system', 0], ['figma', 'prototype', 0],
      ['notion', 'project planning', 0], ['notion', 'database', 0],
      ['slack', 'channel', 0], ['slack', 'dm thread', 0],
      ['teams', 'meeting', 0], ['teams', 'calendar', 0],
      ['zoom', 'standup call', 0], ['zoom', 'screen share', 0],
      ['outlook', 'inbox', 0], ['outlook', 'compose email', 0],
      ['word', 'document.docx', 0], ['excel', 'spreadsheet', 0],
      ['jira', 'sprint board', 0], ['trello', 'card', 0],
      ['asana', 'task', 0], ['linear', 'issue', 0],
      ['todoist', 'todo list', 0], ['miro', 'whiteboard', 0],
      ['calendar', 'schedule', 0], ['mail', 'inbox', 0],
      ['clickup', 'project', 0], ['monday', 'board', 0],
      ['confluence', 'wiki page', 0], ['airtable', 'base', 0],
      ['lucid', 'diagram', 0], ['evernote', 'note', 0],
      ['onenote', 'notebook', 0], ['ticktick', 'task', 0],
      ['canva', 'design', 0],

      // Gaming → gaming
      ['steam', 'library', 1], ['steam', 'store', 1],
      ['valorant', 'match', 1], ['valorant', 'competitive', 1],
      ['leagueoflegends', 'game', 1], ['leagueoflegends', 'champion select', 1],
      ['minecraft', 'world', 1], ['minecraft', 'survival', 1],
      ['fortnite', 'battle pass', 1], ['fortnite', 'lobby', 1],
      ['epicgames', 'store', 1], ['overwatch', 'match', 1],
      ['genshinimpact', 'quest', 1], ['genshinimpact', 'domain', 1],
      ['roblox', 'game', 1], ['csgo', 'competitive', 1],
      ['dota2', 'match', 1], ['wow', 'raid', 1],
      ['warmane', 'realm', 1], ['diablo', 'dungeon', 1],
      ['cyberpunk', 'night city', 1], ['witcher', 'quest', 1],
      ['gta5', 'online', 1], ['r5apex', 'arena', 1],
      ['pubg', 'battlegrounds', 1], ['valheim', 'viking', 1],
      ['ffxiv', 'duty', 1], ['baldursgate', 'adventure', 1],
      ['starfield', 'space', 1], ['eaapp', 'launcher', 1],
      ['battle.net', 'blizzard', 1], ['genshin', 'impact', 1],
      ['riotclientservices', 'game', 1], ['tl', 'throne and liberty', 1],
      ['eso', 'elder scrolls', 1], ['rockstar', 'launcher', 1],
      ['paradox', 'launcher', 1], ['hogwarts', 'legacy', 1],
      ['spiderman', 'marvel', 1], ['godofwar', 'ragnarok', 1],

      // Entertainment sites via browser → gaming (distraction)
      ['chrome', 'youtube watch', 1], ['msedge', 'netflix browse', 1],
      ['firefox', 'reddit frontpage', 1], ['chrome', 'twitch stream', 1],
      ['msedge', 'tiktok video', 1], ['chrome', 'instagram feed', 1],
      ['firefox', 'facebook news', 1], ['chrome', 'pinterest board', 1],
      ['brave', '9gag funny', 1], ['opera', 'imgur gallery', 1],

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
      ['chrome', 'youtube diablo 4 gameplay', 1],
      ['chrome', 'youtube cyberpunk gameplay', 1],
      ['chrome', 'youtube witcher 3 walkthrough', 1],
      ['chrome', 'youtube wow raid gameplay', 1],
      ['chrome', 'youtube apex legends montage', 1],
      ['chrome', 'youtube rocket league gameplay', 1],
      ['chrome', 'youtube elden ring boss fight', 1],
      ['chrome', 'youtube hogwarts legacy gameplay', 1],
      ['chrome', 'youtube baldurs gate playthrough', 1],
      ['chrome', 'youtube starfield gameplay', 1],
      ['chrome', 'youtube god of war gameplay', 1],
      ['chrome', 'youtube spiderman gameplay', 1],
      ['chrome', 'youtube dark souls speedrun', 1],
      ['chrome', 'youtube stream highlights', 1],
      ['chrome', 'youtube funny gaming moments', 1],
      ['chrome', 'youtube gaming montage', 1],
      ['chrome', 'youtube loot opening', 1],
      ['chrome', 'youtube gacha roll', 1],
      ['msedge', 'youtube world of tanks', 1],
      ['msedge', 'youtube war thunder', 1],
      ['msedge', 'youtube minecraft gameplay', 1],
      ['msedge', 'youtube valorant highlights', 1],
      ['firefox', 'youtube gta5 gameplay', 1],
      ['firefox', 'youtube fortnite gameplay', 1],

      // YouTube entertainment (movies, music, vlogs) → gaming
      ['chrome', 'youtube movie trailer', 1],
      ['chrome', 'youtube music video', 1],
      ['chrome', 'youtube reaction video', 1],
      ['chrome', 'youtube vlog', 1],
      ['chrome', 'youtube funny compilation', 1],
      ['chrome', 'youtube asmr relaxing', 1],
      ['chrome', 'youtube prank video', 1],
      ['chrome', 'youtube challenge video', 1],

      // Work browsing → work
      ['chrome', 'github repository', 0], ['msedge', 'stackoverflow question', 0],
      ['firefox', 'documentation api', 0], ['chrome', 'supabase dashboard', 0],
      ['chrome', 'figma file', 0], ['msedge', 'notion page', 0],
      ['chrome', 'envato elements', 0], ['chrome', 'npmjs package', 0],
      ['firefox', 'mdn web docs', 0], ['chrome', 'vercel deploy', 0],
      ['msedge', 'google docs', 0], ['chrome', 'aws console', 0],
      ['firefox', 'docker hub', 0], ['chrome', 'localhost:3000', 0],

      // Communication → ai-decide
      ['discord', 'server chat', 3], ['discord', 'voice channel', 3],
      ['telegram', 'channel', 3], ['telegram', 'group chat', 3],
      ['whatsapp', 'conversation', 3], ['skype', 'call', 3],

      // Browsers general → ai-decide
      ['chrome', 'new tab', 3], ['msedge', 'new tab', 3],
      ['firefox', 'new tab', 3], ['brave', 'new tab', 3],
      ['opera', 'new tab', 3], ['arc', 'space', 3],
      ['vivaldi', 'new tab', 3],

      // System → ignore
      ['taskhostw', '', 2], ['svchost', '', 2],
      ['systemsettings', 'settings', 2], ['searchui', '', 2],
      ['runtimebroker', '', 2], ['shellexperiencehost', '', 2],
      ['applicationframehost', '', 2], ['startmenuexperiencehost', '', 2],
      ['searchhost', '', 2], ['sihost', '', 2],

      // Media → ignore
      ['spotify', 'playlist', 2], ['spotify', 'album', 2],

      // YouTube educational → work
      ['chrome', 'youtube tutorial editing', 0],
      ['msedge', 'youtube premiere pro tutorial', 0],
      ['chrome', 'youtube coding tutorial', 0],
      ['firefox', 'youtube programming guide', 0],
    ];
    return data;
  }

  predict(inputVec) {
    // H1: ReLU(W1 * x + b1)
    const h1 = new Float32Array(H1_SIZE);
    for (let h = 0; h < H1_SIZE; h++) {
      let sum = this.b1[h];
      for (let i = 0; i < VOCAB_SIZE_X; i++) {
        sum += this.W1[h * VOCAB_SIZE_X + i] * inputVec[i];
      }
      h1[h] = sum > 0 ? sum : 0;
    }

    // H2: ReLU(W2 * h1 + b2)
    const h2 = new Float32Array(H2_SIZE);
    for (let h = 0; h < H2_SIZE; h++) {
      let sum = this.b2[h];
      for (let i = 0; i < H1_SIZE; i++) {
        sum += this.W2[h * H1_SIZE + i] * h1[i];
      }
      h2[h] = sum > 0 ? sum : 0;
    }

    // Output: softmax(W3 * h2 + b3)
    const logits = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      let sum = this.b3[o];
      for (let h = 0; h < H2_SIZE; h++) {
        sum += this.W3[o * H2_SIZE + h] * h2[h];
      }
      logits[o] = sum;
    }

    let maxLogit = -Infinity;
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      if (logits[o] > maxLogit) maxLogit = logits[o];
    }

    // Clamp to prevent overflow in exp()
    const CLAMP = 20;
    let expSum = 0;
    const probs = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      const clamped = Math.max(-CLAMP, Math.min(CLAMP, logits[o] - maxLogit));
      probs[o] = Math.exp(clamped);
      expSum += probs[o];
    }
    if (expSum === 0) expSum = 1; // safety
    for (let o = 0; o < OUTPUT_SIZE; o++) probs[o] /= expSum;

    return { probs, h1, h2, logits };
  }

  classify(processName, windowTitle) {
    const input = embedProcessInfoX(processName, windowTitle);
    const { probs } = this.predict(input);

    let bestClass = 0, bestProb = probs[0];
    for (let o = 1; o < OUTPUT_SIZE; o++) {
      if (probs[o] > bestProb) { bestProb = probs[o]; bestClass = o; }
    }

    return {
      className: CLASS_NAMES[bestClass],
      confidence: bestProb,
      allProbs: {
        work: probs[0], gaming: probs[1],
        ignore: probs[2], 'ai-decide': probs[3]
      }
    };
  }

  _trainStep(inputVec, correctClass, lr) {
    const { probs, h1, h2 } = this.predict(inputVec);

    const outGrad = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      outGrad[o] = probs[o];
      if (o === correctClass) outGrad[o] -= 1.0;
    }

    // Gradient clipping
    const clip = (v) => Math.max(-1.0, Math.min(1.0, v));

    // Weight decay factor
    const wd = 0.0001;

    // Update W3, b3
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      const g = clip(outGrad[o]);
      for (let h = 0; h < H2_SIZE; h++) {
        this.W3[o * H2_SIZE + h] -= lr * (g * h2[h] + wd * this.W3[o * H2_SIZE + h]);
      }
      this.b3[o] -= lr * g;
    }

    // H2 gradient
    const h2Grad = new Float32Array(H2_SIZE);
    for (let h = 0; h < H2_SIZE; h++) {
      if (h2[h] <= 0) continue;
      for (let o = 0; o < OUTPUT_SIZE; o++) h2Grad[h] += this.W3[o * H2_SIZE + h] * outGrad[o];
    }

    // Update W2, b2
    for (let h = 0; h < H2_SIZE; h++) {
      const g = clip(h2Grad[h]);
      for (let i = 0; i < H1_SIZE; i++) {
        this.W2[h * H1_SIZE + i] -= lr * (g * h1[i] + wd * this.W2[h * H1_SIZE + i]);
      }
      this.b2[h] -= lr * g;
    }

    // H1 gradient
    const h1Grad = new Float32Array(H1_SIZE);
    for (let h = 0; h < H1_SIZE; h++) {
      if (h1[h] <= 0) continue;
      for (let i = 0; i < H2_SIZE; i++) h1Grad[h] += this.W2[i * H1_SIZE + h] * h2Grad[i];
    }

    // Update W1, b1
    for (let h = 0; h < H1_SIZE; h++) {
      const g = clip(h1Grad[h]);
      for (let i = 0; i < VOCAB_SIZE_X; i++) {
        this.W1[h * VOCAB_SIZE_X + i] -= lr * (g * inputVec[i] + wd * this.W1[h * VOCAB_SIZE_X + i]);
      }
      this.b1[h] -= lr * g;
    }
  }

  learn(processName, windowTitle, correctClass, lr = 0.02) {
    const classIdx = CLASS_NAMES.indexOf(correctClass);
    if (classIdx === -1) return;
    const input = embedProcessInfoX(processName, windowTitle);
    for (let step = 0; step < 5; step++) this._trainStep(input, classIdx, lr);
    this.trained++;
  }

  serialize() {
    return {
      version: this.version, trained: this.trained,
      W1: Array.from(this.W1), b1: Array.from(this.b1),
      W2: Array.from(this.W2), b2: Array.from(this.b2),
      W3: Array.from(this.W3), b3: Array.from(this.b3)
    };
  }

  static deserialize(data) {
    const net = new MicroNetExtended();
    if (data) {
      net.version = data.version || 2;
      net.trained = data.trained || 0;
      if (data.W1) net.W1 = Float32Array.from(data.W1);
      if (data.b1) net.b1 = Float32Array.from(data.b1);
      if (data.W2) net.W2 = Float32Array.from(data.W2);
      if (data.b2) net.b2 = Float32Array.from(data.b2);
      if (data.W3) net.W3 = Float32Array.from(data.W3);
      if (data.b3) net.b3 = Float32Array.from(data.b3);
    }
    return net;
  }
}

module.exports = {
  MicroNetExtended,
  embedProcessInfoX,
  embedTextX,
  CLASS_NAMES,
  VOCAB_SIZE_X,
  H1_SIZE,
  H2_SIZE,
  OUTPUT_SIZE
};
