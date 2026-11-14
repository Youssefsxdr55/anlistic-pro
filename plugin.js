/**
 * Anlistic Pro Plugin for Super Productivity
 * Scans all computer files for productivity tracking and task extraction
 */

// PluginAPI is injected by Super Productivity at runtime
// eslint-disable-next-line no-undef
PluginAPI.on('ready', async () => {
  console.log('[Anlistic Pro] Plugin initialized');
});

// Listen for file scan requests from the UI
PluginAPI.on('anlistic_pro_scan_request', async (params) => {
  const { paths, fileTypes, recursive, maxDepth } = params || {};
  const scanner = new AnlisticScanner({
    paths: paths || [process.env.HOME || 'C:\\Users\\LENOVO'],
    fileTypes: fileTypes || ['.txt', '.md', '.csv', '.pdf'],
    recursive: recursive !== false,
    maxDepth: maxDepth || 5
  });

  const results = await scanner.scan();
  return {
    success: true,
    scanned: results.scanned,
    files: results.files,
    tasks: results.tasks,
    errors: results.errors,
    duration: results.duration
  };
});

// Listen for single file scan
PluginAPI.on('anlistic_pro_scan_file', async (filePath) => {
  try {
    const content = await AnlisticScanner.readFile(filePath);
    const tasks = AnlisticScanner.extractTasks(content, filePath);
    return {
      success: true,
      filePath: filePath,
      content: content,
      tasks: tasks,
      size: Buffer.byteLength(content, 'utf8')
    };
  } catch (err) {
    return {
      success: false,
      filePath: filePath,
      error: err.message
    };
  }
});

// Export for module use
window.AnlisticScanner = AnlisticScanner;

/**
 * Scans specified paths for files and extracts productivity data
 */
class AnlisticScanner {
  constructor(options = {}) {
    this.paths = options.paths || [process.env.HOME || 'C:\\Users\\LENOVO'];
    this.fileTypes = options.fileTypes || ['.txt', '.md', '.csv', '.pdf'];
    this.recursive = options.recursive !== false;
    this.maxDepth = options.maxDepth || 10;
    this.scanned = 0;
    this.files = [];
    this.tasks = [];
    this.errors = [];
    this.duration = 0;
  }

  /**
   * Perform the scan
   */
  async scan() {
    const start = Date.now();

    for (const basePath of this.paths) {
      try {
        await this.scanPath(basePath, 0);
      } catch (err) {
        this.errors.push({ path: basePath, error: err.message });
      }
    }

    this.duration = Date.now() - start;
    return {
      scanned: this.scanned,
      files: this.files,
      tasks: this.tasks,
      errors: this.errors,
      duration: this.duration
    };
  }

  /**
   * Scan a single path recursively
   */
  async scanPath(basePath, depth) {
    if (depth >= this.maxDepth) return;

    const stats = await AnlisticScanner.stat(basePath);
    if (!stats) {
      this.errors.push({ path: basePath, error: 'Access denied or invalid path' });
      return;
    }

    if (stats.isDirectory()) {
      await this.scanDirectory(basePath, depth);
    } else if (stats.isFile()) {
      await this.processFile(basePath);
    }
  }

  /**
   * Scan a directory
   */
  async scanDirectory(dirPath, depth) {
    let entries;
    try {
      entries = await AnlisticScanner.readdir(dirPath);
    } catch (err) {
      this.errors.push({ path: dirPath, error: err.message });
      return;
    }

    for (const entry of entries) {
      const fullPath = AnlisticScanner.join(dirPath, entry);
      await this.scanPath(fullPath, depth + 1);
    }
  }

  /**
   * Process a file - check extension and extract tasks
   */
  async processFile(filePath) {
    if (!AnlisticScanner.isIgnored(filePath)) {
      const ext = AnlisticScanner.getExtension(filePath);
      if (this.fileTypes.includes(ext)) {
        try {
          const content = await AnlisticScanner.readFile(filePath);
          const tasks = AnlisticScanner.extractTasks(content, filePath);
          this.files.push({
            path: filePath,
            size: Buffer.byteLength(content, 'utf8'),
            ext: ext,
            taskCount: tasks.length
          });
          this.tasks.push(...tasks);
          this.scanned++;
        } catch (err) {
          this.errors.push({ path: filePath, error: err.message });
        }
      }
    }
  }

  /**
   * Read a file with UTF-8 encoding
   */
  static async readFile(filePath) {
    try {
      return await AnlisticScanner.fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Read failed: ${err.message}`);
    }
  }

  /**
   * Get file extension (lowercase, no dot)
   */
  static getExtension(filePath) {
    const name = AnlisticScanner.path.basename(filePath);
    const parts = name.split('.');
    return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
  }

  /**
   * Check if a file should be ignored
   */
  static isIgnored(filePath) {
    const ignoredDirs = ['node_modules', '.git', 'AppData', 'Program Files', 'Program Files (x86)', 'Windows', 'System32', 'SysWOW64', 'Recovery'];
    const name = AnlisticScanner.path.basename(filePath);
    const lowerName = name.toLowerCase();

    if (lowerName.startsWith('.')) return true; // hidden files
    if (lowerName.includes('~$')) return true; // temp files
    if (ignoredDirs.some(d => lowerName === d.toLowerCase())) return true;
    if (lowerName === 'thumbs.db' || lowerName === 'desktop.ini') return true;

    return false;
  }

  /**
   * Extract tasks from file content
   */
  static extractTasks(content, filePath) {
    const tasks = [];
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();

      // Todoist-style tasks: [x] or [ ] prefix
      const todoMatch = trimmed.match(/^\[(x| )\]\s+(.+)/i);
      if (todoMatch) {
        tasks.push({
          type: 'todoist',
          text: todoMatch[2].trim(),
          completed: todoMatch[1].toLowerCase() === 'x',
          source: filePath,
          line: lineNumber(content, trimmed)
        });
        continue;
      }

      // GTD style: @next, @waiting, @someday
      if (/\@(next|waiting|someday|today|maybe)\b/i.test(trimmed)) {
        tasks.push({
          type: 'gtd',
          text: trimmed,
          priority: /\@next/i.test(trimmed) ? 'high' : 'medium',
          source: filePath,
          line: lineNumber(content, trimmed)
        });
        continue;
      }

      // Time-based: "in 5 minutes", "at 3pm", "tomorrow"
      if (/\bin\s+\d+\s*(min|hour|hour)\b/i.test(trimmed)) {
        tasks.push({
          type: 'time_based',
          text: trimmed,
          source: filePath,
          line: lineNumber(content, trimmed)
        });
        continue;
      }

      // Project-oriented: [project]
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        tasks.push({
          type: 'project',
          text: trimmed.slice(1, -1).trim(),
          source: filePath,
          line: lineNumber(content, trimmed)
        });
        continue;
      }

      // Email-style: From: / Subject:
      if (/^(From|Subject|To):/i.test(trimmed)) {
        tasks.push({
          type: 'email',
          text: trimmed,
          source: filePath,
          line: lineNumber(content, trimmed)
        });
      }
    }

    return tasks;
  }

  /**
   * Get filesystem module (Node.js fs available in plugin context)
   */
  static get fs() {
    return require('fs');
  }

  /**
   * Get path module
   */
  static get path() {
    return require('path');
  }

  /**
   * Stat a file/directory
   */
  static stat(filePath) {
    return AnlisticScanner.fs.promises.stat(filePath);
  }

  /**
   * Read directory contents
   */
  static readdir(dirPath) {
    return AnlisticScanner.fs.promises.readdir(dirPath);
  }

  /**
   * Join paths properly
   */
  static join(...paths) {
    return AnlisticScanner.path.join(...paths);
  }
}

// Helper to get 1-based line number of a match
function lineNumber(content, match) {
  const lines = content.split(/\r?\n/);
  let count = 1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === match) { count = i + 1; break; }
  }
  return count;
}
