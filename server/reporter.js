// Playwright 커스텀 리포터. 재시도 포함 모든 시도의 스텝·오류·첨부를 AutoTC 형식 JSON으로 남긴다.
const fs = require('fs');
const path = require('path');

const stripAnsi = (s) => (s ? s.replace(/\u001b\[[0-9;]*m/g, '') : s);

class AutoTcReporter {
  constructor(options = {}) {
    this.outputFile = options.outputFile;
    this.tests = new Map();
  }

  printsToStdio() {
    return false;
  }

  onTestEnd(test, result) {
    let entry = this.tests.get(test.id);
    if (!entry) {
      const project = test.parent.project();
      entry = { title: test.title, project: project ? project.name : '', file: test.location.file, attempts: [] };
      this.tests.set(test.id, entry);
    }
    entry.outcome = test.outcome();
    entry.attempts.push({
      retry: result.retry,
      status: result.status,
      duration: result.duration,
      error: result.error ? stripAnsi(result.error.message || String(result.error.value || '')) : null,
      steps: result.steps
        .filter((s) => s.category === 'test.step')
        .map((s) => ({ title: s.title, duration: s.duration, error: s.error ? stripAnsi(s.error.message || '') : null })),
      attachments: result.attachments
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, path: a.path, contentType: a.contentType })),
    });
  }

  onEnd(result) {
    fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
    fs.writeFileSync(this.outputFile, JSON.stringify({ status: result.status, tests: [...this.tests.values()] }, null, 2), 'utf8');
  }
}

module.exports = AutoTcReporter;
