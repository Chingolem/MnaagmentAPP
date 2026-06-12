// ═════════════════════════════════════════════════════════════════
// TIMEROI MicroNet v3 — Large Multilingual Neural Classifier (Upgraded)
// ═════════════════════════════════════════════════════════════════
//
// 8192-dim embeddings, 1024 hidden neurons, sparse updates.
// ~84MB serialized weight size. Supports Latin, CJK, Cyrillic, Arabic scripts.
// Highly optimized sparse matrix operations (<1ms inference on CPU).
//
// Architecture:
//   Input:  8192-dim multilingual n-gram + positional embedding
//   Hidden: 1024 neurons, ReLU
//   Output: 5 classes (work, gaming, entertainment, ignore, ai-decide)
//
// ═════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const VOCAB_SIZE = 8192;
const HIDDEN_SIZE = 1024;
const OUTPUT_SIZE = 5;

const CLASS_NAMES = ['work', 'gaming', 'entertainment', 'ignore', 'ai-decide'];

// ─────────────────────────────────────────────
// MULTILINGUAL N-GRAM EMBEDDER
// Unicode-aware extraction.
// Supports: English, Spanish, Turkish, Russian,
// Arabic, German, French, Japanese, Chinese, Korean
// ─────────────────────────────────────────────

const DOMAIN_NGRAMS = [
  // ═══ English - Creative Tools ═══
  'prem','remi','emie','mier','iere','eres','phot','hote','otos','tosh',
  'illu','llus','lust','blen','lend','capc','apcu','obs6','vide','edit',
  'ligh','ight','cine','inema','unit','nity','davi','avic','fina','lcut',
  'auda','udac','afte','ftef','ind','des','hits','itfi','houd','oudi',
  'zbru','brus','subs','ubst','mudb','udbo','film','ilma','kine','inem',
  'navi','avig','uea','ueaf','sona','onar','alcu','vega',
  // ═══ English - Dev Tools ═══
  'vsco','scode','webs','bsto','curs','urso','inte','ntel','pych','char',
  'gola','gola','ruby','phps','ride','ider','dock','ostm','insom','nsom',
  'npm','yarn','term','ermi','powe','shel','gith','ithub','code',
  // ═══ English - Productivity ═══
  'figm','igma','noti','slac','lack','team','eams','zoom','outl','word',
  'exce','jira','trel','asaa','asna','line','inea','miro','luci','airt',
  'clic','mday','todo','tick','cale','alen','mail','canv',
  // ═══ English - Gaming ═══
  'stee','team','valo','oran','riot','leag','eagu','mine','craf','raft',
  'fort','nite','epic','pube','over','watc','gens','inim','robl','diab',
  'witc','cybe','rpun','gta5','spid','god','war','batt','netl','star',
  'hogw','thro','libe','wot','tanks','world','tank','worldoftanks','game','play',
  // ═══ English - Entertainment ═══
  'yout','outu','tube','twit','tch','redd','netf','etfl','face','inst',
  'tikto','pint','hulu','disn','prim','crun','func','imgu','amaz','9gag',
  // ═══ English - Communication ═══
  'disc','isco','cord','tele','eleg','gram','what','hats','skyp',
  // ═══ English - System ═══
  'task','svch','chos','sett','shel','runt','brok','sear','star','menu',
  'host',
  // ═══ English - Work Keywords ═══
  'enva','nvat','moti','arr','shut','beh','supa','basa','verc','loca',
  'gith','npmj','webp','vite','next','tail','wind','type','crip','dock',
  'kube','awsa','azur','gcp','api','sql',
  // ═══ Spanish - Creative/Work ═══
  'edic','dici','mont','onta','dise','isen','produ','rodu','traba','abaj',
  'proye','roye','video','grab',' Grab','estud','stud','curso','apre','prend',
  'herr','eram','softw','oftw',
  // ═══ Spanish - Gaming ═══
  'jueg','uego','part','tida','diver','iver','entre','ntre','consol','onso',
  // ═══ Turkish - Creative/Work ═══
  'duze','duen','mont','video','tasa','asar','cali','alis','proje','roje',
  'ders','prog','yazi','softw',
  // ═══ Turkish - Gaming ═══
  'oyun','eyle','eglence','oyun',
  // ═══ Russian - Creative/Work ═══
  'mont','onta','redak','edit','proek','proj','dizay','work','softw','video',
  'rabot','abot','ucheb','prog','code','codi',
  // ═══ Russian - Gaming ═══
  'igra','game','igry','razvl','razv',
  // ═══ Arabic - Creative/Work ═══
  'تحر','تصر','تصم','مشرو','عمل','انتا','برمج','دروس','تعلم','فيديو',
  // ═══ Arabic - Gaming ═══
  'لعب','ألع','ترفي','سوني','بلاي',
  // ═══ German - Creative/Work ═══
  'bearb','earb','schnitt','esig','projekt','arbe','softw','video','kurs',
  'lernen','entwi','prog',
  // ═══ German - Gaming ═══
  'spiel','piel','unter','halt','game',
  // ═══ French - Creative/Work ═══
  'monta','edit','conce','trava','proje','cour','forme','video','logici',
  // ═══ French - Gaming ═══
  'jeux','jeu','diver','tiss','game','amus',
  // ═══ CJK - Japanese ═══
  '編集','動画','設計','作業','仕事','ソフト',
  'ゲーム','遊','娛楽','プレイ',
  // ═══ CJK - Chinese ═══
  '编辑','视频','设计','工作','软件','开发',
  '游戏','娱乐','玩',
  // ═══ CJK - Korean ═══
  '편집','비디오','디자인','작업','소프트','개발',
  '게임','놀이','오락',
  // ═══ Common file extensions ═══
  '.prproj','.psd','.ai','.aep','.indd','.blend','.tsx','.jsx',
  '.py','.java','.cpp','.js','.ts','.html','.css','.json','.md',
  // ═══ Common patterns ═══
  '64','32','helper','launch','update','service','broker','manager',
  'widget','tray','splash','loader','renderer','worker','daemon',
];

const ngramIndex = {};
[...new Set(DOMAIN_NGRAMS)].forEach((ng, i) => { ngramIndex[ng] = i % VOCAB_SIZE; });

function embedText(text) {
  const vec = new Float32Array(VOCAB_SIZE);
  if (!text) return vec;

  // Normalize: lowercase for Latin, keep CJK/Arabic as-is
  const lower = text.toLowerCase().replace(/[^\w\sЀ-ӿ؀-ۿ一-鿿぀-ゟ゠-ヿ가-힯À-ɏ]/g, '');

  // Multi-scale n-grams (2 through 5)
  for (let n = 2; n <= 5; n++) {
    for (let i = 0; i <= lower.length - n; i++) {
      const gram = lower.substring(i, i + n);

      // Direct vocabulary match
      if (ngramIndex[gram] !== undefined) {
        vec[ngramIndex[gram]] += (1.0 + n * 0.2);
      }

      // Hash bucket for unseen n-grams
      let hash = 0;
      for (let c = 0; c < gram.length; c++) {
        hash = ((hash << 5) - hash + gram.charCodeAt(c)) | 0;
      }
      vec[Math.abs(hash) % VOCAB_SIZE] += 0.3;
    }
  }

  // Positional encoding: first 8 chars get extra signal
  for (let i = 0; i < Math.min(8, lower.length); i++) {
    const posHash = (lower.charCodeAt(i) * (i + 1) * 31) % VOCAB_SIZE;
    vec[Math.abs(posHash)] += 0.6 * (1 - i * 0.08);
  }

  // Character category features (Unicode block detection)
  const catBuckets = {
    latin: 0, cyrillic: 0, arabic: 0, cjk: 0, hangul: 0, digits: 0, symbols: 0
  };
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if (code >= 0x0400 && code <= 0x04FF) catBuckets.cyrillic++;
    else if (code >= 0x0600 && code <= 0x06FF) catBuckets.arabic++;
    else if (code >= 0x4E00 && code <= 0x9FFF) catBuckets.cjk++;
    else if (code >= 0xAC00 && code <= 0xD7AF) catBuckets.hangul++;
    else if (code >= 0x30 && code <= 0x39) catBuckets.digits++;
    else if (code >= 0x61 && code <= 0x7A) catBuckets.latin++;
    else catBuckets.symbols++;
  }
  // Map category signals into fixed embedding positions
  const catStart = VOCAB_SIZE - 16; // last 16 dims for language signals
  Object.values(catBuckets).forEach((count, idx) => {
    vec[catStart + idx * 2] = Math.min(5, count * 0.1);
    vec[catStart + idx * 2 + 1] = Math.min(1, count > 0 ? 1 : 0);
  });

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
  const procVec = embedText(processName);
  const titleVec = embedText(windowTitle);
  const combined = new Float32Array(VOCAB_SIZE);
  for (let i = 0; i < VOCAB_SIZE; i++) {
    combined[i] = procVec[i] * 0.65 + titleVec[i] * 0.35;
  }
  return combined;
}

// ─────────────────────────────────────────────
// SPARSE-OPTIMIZED NEURAL NETWORK (8192→1024→5)
// ─────────────────────────────────────────────

class MicroNet {
  constructor() {
    this.W1 = new Float32Array(HIDDEN_SIZE * VOCAB_SIZE);
    this.b1 = new Float32Array(HIDDEN_SIZE);
    this.W2 = new Float32Array(OUTPUT_SIZE * HIDDEN_SIZE);
    this.b2 = new Float32Array(OUTPUT_SIZE);
    this._initWeights();
    this.trained = 0;
    this.version = 3;
  }

  _initWeights() {
    const s1 = Math.sqrt(2.0 / VOCAB_SIZE) * 0.15;
    const s2 = Math.sqrt(2.0 / HIDDEN_SIZE) * 0.2;
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (Math.random() - 0.5) * s1;
    for (let i = 0; i < this.b1.length; i++) this.b1[i] = 0;
    for (let i = 0; i < this.W2.length; i++) this.W2[i] = (Math.random() - 0.5) * s2;
    for (let i = 0; i < this.b2.length; i++) this.b2[i] = 0;

    // Pre-train with domain knowledge
    const pretrainData = this._getPretrainData();
    for (let epoch = 0; epoch < 60; epoch++) {
      for (let i = pretrainData.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pretrainData[i], pretrainData[j]] = [pretrainData[j], pretrainData[i]];
      }
      const lr = epoch < 20 ? 0.05 : epoch < 40 ? 0.02 : 0.01;
      for (const [proc, title, cls] of pretrainData) {
        this._trainStep(embedProcessInfo(proc, title), cls, lr);
      }
    }
  }

  _getPretrainData() {
    return [
      // ═══ ENGLISH — Creative → work (class 0) ═══
      ['premiere', 'project.prproj', 0], ['premiere', 'sequence edit', 0],
      ['photoshop', 'design.psd', 0], ['photoshop', 'layer mask', 0],
      ['aftereffects', 'comp.aep', 0], ['aftereffects', 'motion graphics', 0],
      ['illustrator', 'logo.ai', 0], ['illustrator', 'vector art', 0],
      ['blender', 'scene.blend', 0], ['blender', '3d modeling', 0],
      ['resolve', 'color grading', 0], ['capcut', 'editing video', 0],
      ['obs64', 'streaming setup', 0], ['obs', 'recording', 0],
      ['unity', 'game project', 0], ['unreal', 'level editor', 0],
      ['indesign', 'layout.indd', 0], ['lightroom', 'photo edit', 0],
      ['audition', 'audio mix', 0], ['vegas', 'video edit', 0],
      ['audacity', 'recording', 0], ['cinema4d', '3d render', 0],
      ['finalcut', 'timeline', 0], ['hitfilm', 'vfx composite', 0],
      ['nuke', 'compositing', 0], ['houdini', 'procedural', 0],
      ['zbrush', 'sculpting', 0], ['substance', 'texture paint', 0],
      ['filmora', 'video editing', 0], ['davinci', 'color page', 0],

      // ═══ ENGLISH — Dev → work (class 0) ═══
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
      ['warp', 'terminal', 0], ['hyper', 'zsh shell', 0],

      // ═══ ENGLISH — Productivity → work (class 0) ═══
      ['figma', 'design system', 0], ['notion', 'project planning', 0],
      ['slack', 'channel', 0], ['teams', 'meeting', 0],
      ['zoom', 'standup call', 0], ['outlook', 'inbox', 0],
      ['word', 'document.docx', 0], ['excel', 'spreadsheet', 0],
      ['jira', 'sprint board', 0], ['trello', 'card', 0],
      ['asana', 'task', 0], ['linear', 'issue', 0],
      ['todoist', 'todo list', 0], ['miro', 'whiteboard', 0],
      ['calendar', 'schedule', 0], ['canva', 'design', 0],
      ['clickup', 'project', 0], ['confluence', 'wiki page', 0],

      // ═══ ENGLISH — Gaming → gaming (class 1) ═══
      ['steam', 'library', 1], ['steam', 'store', 1],
      ['valorant', 'match', 1], ['valorant', 'competitive', 1],
      ['leagueoflegends', 'game', 1], ['minecraft', 'world', 1],
      ['fortnite', 'battle pass', 1], ['epicgames', 'store', 1],
      ['overwatch', 'match', 1], ['genshinimpact', 'quest', 1],
      ['roblox', 'game', 1], ['csgo', 'competitive', 1],
      ['dota2', 'match', 1], ['wow', 'raid', 1],
      ['warmane', 'realm', 1], ['diablo', 'dungeon', 1],
      ['cyberpunk', 'night city', 1], ['witcher', 'quest', 1],
      ['gta5', 'online', 1], ['r5apex', 'arena', 1],
      ['pubg', 'battlegrounds', 1], ['valheim', 'viking', 1],
      ['ffxiv', 'duty', 1], ['baldursgate', 'adventure', 1],
      ['starfield', 'space', 1], ['eaapp', 'launcher', 1],
      ['battle.net', 'blizzard', 1], ['genshin', 'impact', 1],
      ['riotclient', 'game', 1], ['tl', 'throne and liberty', 1],
      ['eso', 'elder scrolls', 1], ['rockstar', 'launcher', 1],
      // World of Tanks explicit overrides (gaming)
      ['worldoftanks', 'world of tanks', 1],
      ['worldoftanks', 'wot', 1],
      ['worldoftanks', 'garage', 1],
      ['wot', 'wot', 1],
      ['wot', 'world of tanks', 1],
      ['world of tanks', 'login', 1],

      // ═══ ENGLISH — Entertainment (class 2) ═══
      ['chrome', 'youtube', 2],
      ['chrome', 'youtube video', 2],
      ['chrome', 'watch youtube', 2],
      ['chrome', 'netflix browse', 2],
      ['chrome', 'netflix movie', 2],
      ['chrome', 'twitch stream', 2],
      ['chrome', 'twitch chat', 2],
      ['chrome', 'reddit frontpage', 2],
      ['chrome', 'reddit.com', 2],
      ['chrome', 'instagram feed', 2],
      ['chrome', 'facebook news', 2],
      ['chrome', 'tiktok video', 2],
      ['chrome', 'disney plus', 2],
      ['chrome', 'amazon prime video', 2],
      ['msedge', 'youtube stream', 2],
      ['msedge', 'twitch stream', 2],
      ['msedge', 'tiktok video', 2],
      ['msedge', 'netflix browse', 2],
      ['firefox', 'youtube stream', 2],
      ['firefox', 'netflix stream', 2],
      ['chrome', '9gag funny', 2],
      ['chrome', 'imgur gallery', 2],

      // ═══ ENGLISH — Work browsing → work (class 0) ═══
      ['chrome', 'github repository', 0], ['msedge', 'stackoverflow question', 0],
      ['firefox', 'documentation api', 0], ['chrome', 'supabase dashboard', 0],
      ['chrome', 'figma file', 0], ['msedge', 'notion page', 0],
      ['chrome', 'envato elements', 0], ['chrome', 'npmjs package', 0],
      ['firefox', 'mdn web docs', 0], ['chrome', 'vercel deploy', 0],

      // ═══ Communication → ai-decide (class 4) ═══
      ['discord', 'server chat', 4], ['discord', 'voice channel', 4],
      ['telegram', 'channel', 4], ['telegram', 'group chat', 4],
      ['whatsapp', 'conversation', 4], ['skype', 'call', 4],

      // ═══ System → ignore (class 3) ═══
      ['taskhostw', '', 3], ['svchost', '', 3],
      ['systemsettings', 'settings', 3], ['searchui', '', 3],
      ['runtimebroker', '', 3], ['shellexperiencehost', '', 3],
      ['applicationframehost', '', 3], ['startmenuexperiencehost', '', 3],

      // ═══ Media → ignore (class 3) ═══
      ['spotify', 'playlist', 3], ['spotify', 'album', 3],

      // ═══ SPANISH — Work ═══
      ['premiere', 'edición de video', 0], ['chrome', 'edición video youtube', 0],
      ['chrome', 'diseño gráfico proyecto', 0], ['chrome', 'montaje video trabajo', 0],
      ['chrome', 'curso edición youtube', 0], ['chrome', 'tutorial premiere español', 0],
      ['chrome', 'aprender edición video', 0], ['chrome', 'herramientas productividad', 0],

      // ═══ SPANISH — Gaming ═══
      ['chrome', 'juegos gameplay youtube', 2], // youtube is entertainment
      ['worldoftanks', 'batalla de tanques', 1],
      ['wot', 'tanques juego', 1],

      // ═══ TURKISH — Work ═══
      ['chrome', 'video düzenleme youtube', 0], ['chrome', 'tasarım proje', 0],
      ['chrome', 'montaj video çalışma', 0], ['chrome', 'yazılım geliştirme', 0],

      // ═══ TURKISH — Gaming/Entertainment ═══
      ['worldoftanks', 'tank savası oyunu', 1],
      ['chrome', 'oyun oynama youtube', 2],

      // ═══ RUSSIAN — Work ═══
      ['chrome', 'видео монтаж youtube', 0], ['chrome', 'редактор дизайн работа', 0],
      ['chrome', 'проект разработка', 0], ['chrome', 'программирование', 0],

      // ═══ RUSSIAN — Gaming/Entertainment ═══
      ['worldoftanks', 'мир танков', 1],
      ['wot', 'бой танки', 1],
      ['chrome', 'геймплей youtube', 2],

      // ═══ ARABIC — Work ═══
      ['chrome', 'تحرير فيديو يوتيوب', 0], ['chrome', 'تصميم مشروع عمل', 0],
      ['chrome', 'برمجة تطوير', 0],

      // ═══ ARABIC — Gaming/Entertainment ═══
      ['worldoftanks', 'لعبة الدبابات', 1],
      ['chrome', 'ألعاب يوتيوب', 2],

      // ═══ GERMAN — Work ═══
      ['chrome', 'videoschnitt youtube', 0], ['chrome', 'design projekt arbeit', 0],

      // ═══ GERMAN — Gaming/Entertainment ═══
      ['worldoftanks', 'panzer spiel', 1],
      ['chrome', 'gameplay youtube', 2],

      // ═══ FRENCH — Work ═══
      ['chrome', 'montage vidéo youtube', 0], ['chrome', 'conception projet travail', 0],

      // ═══ FRENCH — Gaming/Entertainment ═══
      ['worldoftanks', 'jeu de char de combat', 1],
      ['chrome', 'jeux vidéo youtube', 2],

      // ═══ JAPANESE — Work ═══
      ['chrome', '動画編集 youtube', 0], ['chrome', 'デザイン プロジェクト 仕事', 0],

      // ═══ JAPANESE — Gaming/Entertainment ═══
      ['worldoftanks', '戦車ゲーム', 1],
      ['chrome', 'プレイ動画 youtube', 2],

      // ═══ CHINESE — Work ═══
      ['chrome', '视频编辑 youtube', 0], ['chrome', '设计 项目 工作', 0],

      // ═══ CHINESE — Gaming/Entertainment ═══
      ['worldoftanks', '坦克世界', 1],
      ['chrome', '游戏视频 youtube', 2],

      // ═══ KOREAN — Work ═══
      ['chrome', '비디오 편집 youtube', 0], ['chrome', '디자인 프로젝트 작업', 0],

      // ═══ KOREAN — Gaming/Entertainment ═══
      ['worldoftanks', '월드 오브 탱크', 1],
      ['chrome', '게임플레이 youtube', 2],
    ];
  }

  predict(inputVec) {
    const hidden = new Float32Array(HIDDEN_SIZE);
    
    // Find active indices to optimize matrix multiplication (sparse)
    const activeIndices = [];
    const activeValues = [];
    for (let i = 0; i < VOCAB_SIZE; i++) {
      if (inputVec[i] !== 0) {
        activeIndices.push(i);
        activeValues.push(inputVec[i]);
      }
    }

    for (let h = 0; h < HIDDEN_SIZE; h++) {
      let sum = this.b1[h];
      const offset = h * VOCAB_SIZE;
      for (let k = 0; k < activeIndices.length; k++) {
        sum += this.W1[offset + activeIndices[k]] * activeValues[k];
      }
      hidden[h] = sum > 0 ? sum : 0;
    }

    const logits = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      let sum = this.b2[o];
      for (let h = 0; h < HIDDEN_SIZE; h++) sum += this.W2[o * HIDDEN_SIZE + h] * hidden[h];
      logits[o] = sum;
    }

    let maxLogit = -Infinity;
    for (let o = 0; o < OUTPUT_SIZE; o++) if (logits[o] > maxLogit) maxLogit = logits[o];

    let expSum = 0;
    const probs = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      const clamped = Math.max(-20, Math.min(20, logits[o] - maxLogit));
      probs[o] = Math.exp(clamped);
      expSum += probs[o];
    }
    if (expSum === 0) expSum = 1;
    for (let o = 0; o < OUTPUT_SIZE; o++) probs[o] /= expSum;

    return { probs, hidden, logits, activeIndices, activeValues };
  }

  classify(processName, windowTitle) {
    const input = embedProcessInfo(processName, windowTitle);
    const { probs } = this.predict(input);

    let bestClass = 0, bestProb = probs[0];
    for (let o = 1; o < OUTPUT_SIZE; o++) {
      if (probs[o] > bestProb) { bestProb = probs[o]; bestClass = o; }
    }

    return {
      className: CLASS_NAMES[bestClass],
      confidence: bestProb,
      allProbs: { work: probs[0], gaming: probs[1], entertainment: probs[2], ignore: probs[3], 'ai-decide': probs[4] }
    };
  }

  _trainStep(inputVec, correctClass, lr) {
    const { probs, hidden, activeIndices, activeValues } = this.predict(inputVec);

    const outGrad = new Float32Array(OUTPUT_SIZE);
    for (let o = 0; o < OUTPUT_SIZE; o++) {
      outGrad[o] = probs[o];
      if (o === correctClass) outGrad[o] -= 1.0;
    }

    const clip = (v) => Math.max(-1.0, Math.min(1.0, v));
    const wd = 0.0001;

    for (let o = 0; o < OUTPUT_SIZE; o++) {
      const g = clip(outGrad[o]);
      for (let h = 0; h < HIDDEN_SIZE; h++) {
        this.W2[o * HIDDEN_SIZE + h] -= lr * (g * hidden[h] + wd * this.W2[o * HIDDEN_SIZE + h]);
      }
      this.b2[o] -= lr * g;
    }

    const hiddenGrad = new Float32Array(HIDDEN_SIZE);
    for (let h = 0; h < HIDDEN_SIZE; h++) {
      if (hidden[h] <= 0) continue;
      for (let o = 0; o < OUTPUT_SIZE; o++) hiddenGrad[h] += this.W2[o * HIDDEN_SIZE + h] * outGrad[o];
    }

    for (let h = 0; h < HIDDEN_SIZE; h++) {
      const g = clip(hiddenGrad[h]);
      if (g === 0) continue;
      for (let k = 0; k < activeIndices.length; k++) {
        const idx = activeIndices[k];
        const val = activeValues[k];
        this.W1[h * VOCAB_SIZE + idx] -= lr * (g * val + wd * this.W1[h * VOCAB_SIZE + idx]);
      }
      this.b1[h] -= lr * g;
    }
  }

  learn(processName, windowTitle, correctClass, lr = 0.02) {
    const classIdx = CLASS_NAMES.indexOf(correctClass);
    if (classIdx === -1) return;
    const input = embedProcessInfo(processName, windowTitle);
    for (let step = 0; step < 5; step++) this._trainStep(input, classIdx, lr);
    this.trained++;
  }

  serialize() {
    return {
      version: this.version, trained: this.trained,
      W1: Array.from(this.W1), b1: Array.from(this.b1),
      W2: Array.from(this.W2), b2: Array.from(this.b2)
    };
  }

  static deserialize(data) {
    const net = new MicroNet();
    if (data) {
      // Dimension checks
      if (data.W1 && data.W1.length === net.W1.length &&
          data.b1 && data.b1.length === net.b1.length &&
          data.W2 && data.W2.length === net.W2.length &&
          data.b2 && data.b2.length === net.b2.length) {
        net.version = data.version || 3;
        net.trained = data.trained || 0;
        net.W1 = Float32Array.from(data.W1);
        net.b1 = Float32Array.from(data.b1);
        net.W2 = Float32Array.from(data.W2);
        net.b2 = Float32Array.from(data.b2);
      } else {
        console.log('[MicroNet] Dimension mismatch or missing weights. Starting fresh with pre-trained weights.');
      }
    }
    return net;
  }
}

module.exports = { MicroNet, embedProcessInfo, embedText, CLASS_NAMES, VOCAB_SIZE, HIDDEN_SIZE, OUTPUT_SIZE };
