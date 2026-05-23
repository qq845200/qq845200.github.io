// fetch-skills.js - 从 GitHub API 采集 AI 编程技能数据 + 自动中文翻译
// 用法: GITHUB_TOKEN=xxx node scripts/fetch-skills.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GITHUB_TOKEN || '';
const OUTPUT = path.join(__dirname, '..', 'skills-data.json');
const TRANS_FILE = path.join(__dirname, '..', 'translations.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'qq845200-skills-bot',
        Accept: 'application/vnd.github.v3+json',
      },
    };
    if (TOKEN) opts.headers.Authorization = `token ${TOKEN}`;

    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

// MyMemory 免费翻译 API
function translate(text) {
  if (!text || /[一-鿿]/.test(text.slice(0, 20))) return Promise.resolve(text);
  return new Promise((resolve) => {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=en|zh-CN`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const translated = json.responseData?.translatedText || '';
          // 翻译质量检查：不能是原文、不能太短
          if (translated && translated !== text && translated.length > 2) {
            resolve(translated);
          } else {
            resolve('');
          }
        } catch {
          resolve('');
        }
      });
    }).on('error', () => resolve(''));
  });
}

// 搜索 GitHub 仓库
async function searchRepos(query, maxResults = 15) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${maxResults}`;
  const data = await fetch(url);
  return (data.items || []).map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    description: (repo.description || '').slice(0, 200),
    url: repo.html_url,
    homepage: repo.homepage || '',
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    language: repo.language || '',
    topics: repo.topics || [],
    updatedAt: repo.updated_at ? repo.updated_at.slice(0, 10) : '',
    openIssues: repo.open_issues_count || 0,
  }));
}

// 加载已有翻译
function loadTranslations() {
  try {
    return JSON.parse(fs.readFileSync(TRANS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// 保存翻译
function saveTranslations(trans) {
  fs.writeFileSync(TRANS_FILE, JSON.stringify(trans, null, 2), 'utf8');
}

async function main() {
  console.log('开始采集 AI 技能数据...');

  const translations = loadTranslations();

  const searches = {
    claude: [
      'claude-code skill',
      'claude-code plugin',
      'claude-code custom-skill',
      'claude skill .claude',
      'claude-code CLI skill',
    ],
    codex: [
      'openai codex skill',
      'codex-cli plugin',
      'codex custom-instruction',
      'openai-codex agent',
      'codex-task',
    ],
    openclaw: [
      'openclaw skill',
      'openclaw plugin',
      'open-claw agent',
      'openclaw tool',
      'openclaw extension',
    ],
  };

  const results = {};
  const seen = new Set();
  const newTranslations = [];

  for (const [category, queries] of Object.entries(searches)) {
    const allRepos = [];
    for (const q of queries) {
      try {
        console.log(`  搜索 [${category}]: ${q}`);
        const repos = await searchRepos(q, 10);
        for (const repo of repos) {
          if (!seen.has(repo.id)) {
            seen.add(repo.id);
            allRepos.push(repo);
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        console.warn(`  跳过 [${q}]: ${e.message}`);
      }
    }
    results[category] = allRepos
      .sort((a, b) => b.stars - a.stars)
      .slice(0, 20);
    console.log(`  ${category}: 采集到 ${results[category].length} 个仓库`);
  }

  // 自动翻译缺失的中文
  const allRepos = Object.values(results).flat();
  const needTranslation = allRepos.filter(
    (r) => !translations[r.fullName] || !translations[r.fullName].cnName
  );

  console.log(`\n需要翻译: ${needTranslation.length} 个新技能`);

  for (let i = 0; i < needTranslation.length; i++) {
    const repo = needTranslation[i];
    const existing = translations[repo.fullName] || {};

    // 已有完整翻译则跳过
    if (existing.cnName && existing.cnDesc) continue;

    try {
      console.log(`  翻译 [${i + 1}/${needTranslation.length}]: ${repo.fullName}`);

      // 翻译仓库名
      let cnName = existing.cnName || '';
      if (!cnName) {
        // 用关键词生成中文名
        cnName = generateCnName(repo);
      }

      // 翻译描述
      let cnDesc = existing.cnDesc || '';
      if (!cnDesc && repo.description) {
        const translated = await translate(repo.description);
        if (translated) {
          cnDesc = translated;
        }
        await new Promise((r) => setTimeout(r, 800));
      }

      if (cnName || cnDesc) {
        translations[repo.fullName] = {
          cnName: cnName || existing.cnName || '',
          cnDesc: cnDesc || existing.cnDesc || '',
        };
        newTranslations.push(repo.fullName);
      }
    } catch (e) {
      console.warn(`  翻译失败 [${repo.fullName}]: ${e.message}`);
    }
  }

  // 保存翻译
  if (newTranslations.length > 0) {
    saveTranslations(translations);
    console.log(`\n新增翻译: ${newTranslations.length} 个`);
  } else {
    console.log('\n无需新增翻译');
  }

  // 给每个仓库打上技能分类标签
  for (const repos of Object.values(results)) {
    for (const repo of repos) {
      repo.tags = classifyRepo(repo);
    }
  }

  // 统计各分类数量
  const tagStats = {};
  for (const repos of Object.values(results)) {
    for (const repo of repos) {
      for (const tag of repo.tags) {
        tagStats[tag] = (tagStats[tag] || 0) + 1;
      }
    }
  }

  // 生成输出
  const output = {
    updatedAt: new Date().toISOString().slice(0, 10),
    stats: {
      claude: results.claude.length,
      codex: results.codex.length,
      openclaw: results.openclaw.length,
      total: results.claude.length + results.codex.length + results.openclaw.length,
    },
    tagStats,
    categories: results,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n写入 ${OUTPUT}`);
  console.log(`总计 ${output.stats.total} 个技能`);
}

// 根据仓库信息智能生成中文名
function generateCnName(repo) {
  const name = repo.name.toLowerCase();
  const desc = (repo.description || '').toLowerCase();
  const keywords = {
    // AI 工具类
    'skill': '技能', 'plugin': '插件', 'agent': '代理', 'extension': '扩展',
    'workflow': '工作流', 'automation': '自动化', 'assistant': '助理',
    'dashboard': '仪表盘', 'scanner': '扫描器', 'analyzer': '分析器',
    'generator': '生成器', 'builder': '构建器', 'manager': '管理器',
    'optimizer': '优化器', 'monitor': '监控', 'scheduler': '调度器',
    'translator': '翻译器', 'converter': '转换器', 'validator': '验证器',
    // 开发工具类
    'awesome': '精选集', 'collection': '合集', 'toolkit': '工具包',
    'framework': '框架', 'library': '库', 'template': '模板',
    'boilerplate': '脚手架', 'starter': '启动器', 'cli': '命令行工具',
    'api': 'API 工具', 'config': '配置', 'setup': '配置',
    'design': '设计', 'ui': 'UI', 'ux': 'UX',
    // 领域类
    'code': '代码', 'review': '审查', 'test': '测试',
    'deploy': '部署', 'debug': '调试', 'search': '搜索',
    'chat': '对话', 'translate': '翻译', 'stock': '股票',
    'macd': 'MACD', 'trading': '交易', 'finance': '金融',
    'low-code': '低代码', 'nocode': '零代码',
  };

  // 从仓库名提取关键词
  const parts = name.split(/[-_]/);
  const cnParts = parts.map((p) => keywords[p] || '').filter(Boolean);

  if (cnParts.length > 0) {
    return cnParts.slice(0, 3).join('');
  }

  // 从描述提取
  for (const [en, cn] of Object.entries(keywords)) {
    if (desc.includes(en)) return cn + '工具';
  }

  return '';
}

// 根据仓库信息自动分类
function classifyRepo(repo) {
  const text = `${repo.name} ${repo.description} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const tags = [];

  const rules = [
    { tag: '代码审查', keywords: ['review', 'code-review', 'lint', 'quality', 'audit', 'security'] },
    { tag: '代码生成', keywords: ['generate', 'generation', 'codegen', 'scaffold', 'boilerplate', 'scaffolding'] },
    { tag: 'UI/UX 设计', keywords: ['ui', 'ux', 'design', 'css', 'tailwind', 'frontend', 'component', 'figma', 'theme'] },
    { tag: '自动化', keywords: ['automat', 'workflow', 'ci/cd', 'pipeline', 'cron', 'scheduler', 'bot'] },
    { tag: '测试', keywords: ['test', 'testing', 'e2e', 'unit-test', 'integration', 'coverage', 'qa'] },
    { tag: '部署', keywords: ['deploy', 'deployment', 'devops', 'docker', 'kubernetes', 'cloud', 'hosting'] },
    { tag: '数据分析', keywords: ['data', 'analytics', 'chart', 'visualiz', 'dashboard', 'graph', 'stock', 'macd', 'trading'] },
    { tag: '文档', keywords: ['doc', 'documentation', 'readme', 'markdown', 'wiki', 'writing'] },
    { tag: 'AI 代理', keywords: ['agent', 'multi-agent', 'agentic', 'autonomous', 'llm', 'chatgpt', 'gpt', 'model'] },
    { tag: '开发工具', keywords: ['tool', 'toolkit', 'utility', 'debug', 'editor', 'ide', 'vscode', 'extension'] },
    { tag: '插件市场', keywords: ['marketplace', 'registry', 'directory', 'awesome', 'collection', 'curated'] },
    { tag: '低代码', keywords: ['low-code', 'nocode', 'no-code', 'lowcode'] },
    { tag: 'API 集成', keywords: ['api', 'integration', 'mcp', 'webhook', 'rest', 'graphql'] },
    { tag: '项目管理', keywords: ['project', 'task', 'manage', 'kanban', 'todo', 'issue', 'tracker'] },
  ];

  for (const { tag, keywords } of rules) {
    if (keywords.some((kw) => text.includes(kw))) {
      tags.push(tag);
    }
  }

  // 兜底
  if (tags.length === 0) tags.push('其他');
  return tags;
}

main().catch((e) => {
  console.error('采集失败:', e.message);
  process.exit(1);
});
