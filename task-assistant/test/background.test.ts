import assert from 'node:assert/strict';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import test from 'node:test';
const pkg = fileURLToPath(new URL('..', import.meta.url)),
  cli = path.join(pkg, 'dist/cli.js');
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

test(
  'background supervisor stops its child, latches failures, validates secrets and frozen runtime without live Slack',
  {skip: process.platform !== 'darwin'},
  async t => {
    await mkdir(path.join(pkg, 'tmp'), {recursive: true});
    const dir = await mkdtemp(path.join(pkg, 'tmp/background-e2e-'));
    await chmod(dir, 0o700);
    const root = path.join(dir, 'state');
    await mkdir(path.join(root, 'runs'), {recursive: true});
    const runtime = path.join(dir, 'runtime');
    await mkdir(runtime);
    const marker = path.join(dir, 'started'),
      finished = path.join(dir, 'finished'),
      worker = path.join(runtime, 'worker.mjs');
    const body = `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');console.log('ready');if(process.argv.includes('fail'))process.exit(2);const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(finished)},'stopped');clearInterval(timer);});`;
    await writeFile(worker, body);
    const lock = path.join(dir, 'dependency-lock.json');
    await writeFile(lock, '{}');
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const config = {
      root,
      node: process.execPath,
      args: [worker],
      runtime: {'worker.mjs': hash(body)},
      dependency_lock: {file: lock, hash: hash('{}')},
    };
    const save = async (file: string, value: unknown) =>
      writeFile(path.join(dir, file), JSON.stringify(value), {mode: 0o600});
    await save('settings.json', config);
    await save('credentials.json', {
      SLACK_USER_TOKEN: 'test-private-user',
      SLACK_BOT_TOKEN: 'test-private-bot',
    });
    await save('control.json', {paused: false});
    const children: ChildProcess[] = [];
    const start = () => {
      const p = spawn(
        process.execPath,
        [cli, 'service', 'run', '--directory', dir],
        {
          env: {PATH: process.env.PATH, HOME: dir},
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(p);
      let stdout = '',
        stderr = '';
      p.stdout!.on('data', c => (stdout += c));
      p.stderr!.on('data', c => (stderr += c));
      const ended = new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>(resolve => p.once('exit', code => resolve({code, stdout, stderr})));
      return {p, ended};
    };
    const wait = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        try {
          if (await check()) return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        await sleep(20);
      }
      throw Error('Fixture timeout');
    };
    t.after(() => {
      for (const p of children)
        if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    });
    const running = start();
    await wait(
      async () =>
        Boolean((await json(path.join(dir, 'status.json'))).worker_pid) &&
        Boolean(await readFile(marker, 'utf8')),
    );
    const status = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'service', 'status', '--directory', dir],
        {encoding: 'utf8'},
      ),
    );
    assert.equal(status.worker_alive, true);
    assert.equal(status.supervisor_alive, true);
    assert.doesNotMatch(JSON.stringify(status), /test-private-/);
    const getStatus = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [cli, 'service', 'status', '--directory', dir],
          {encoding: 'utf8'},
        ),
      );
    assert.equal(status.monitoring, 'starting');
    await save('state/runs/slack-read-health.json', {
      state: 'monitoring',
      checked_at: new Date(Date.now() - 400000).toISOString(),
    });
    assert.equal(getStatus().monitoring, 'stale');
    await save('state/runs/slack-read-health.json', {
      state: 'waiting_for_slack',
      checked_at: new Date().toISOString(),
    });
    assert.equal(getStatus().monitoring, 'waiting_for_slack');
    const pid = status.status.worker_pid;
    running.p.kill('SIGTERM');
    const stopped = await running.ended;
    assert.equal(stopped.code, 0);
    assert.equal((await json(path.join(dir, 'status.json'))).state, 'stopped');
    assert.equal(getStatus().monitoring, 'stopped');
    assert.equal(await readFile(finished, 'utf8'), 'stopped');
    assert.throws(
      () => process.kill(pid, 0),
      e => (e as NodeJS.ErrnoException).code === 'ESRCH',
    );
    await save('settings.json', {...config, args: [worker, 'fail']});
    const failed = await start().ended;
    assert.equal(failed.code, 1);
    assert.equal((await json(path.join(dir, 'status.json'))).state, 'failed');
    assert.equal(getStatus().monitoring, 'failed');
    const calls = await readFile(marker, 'utf8');
    const latched = await start().ended;
    assert.equal(latched.code, 0);
    assert.match(latched.stdout, /Explicit service start required/);
    assert.equal(await readFile(marker, 'utf8'), calls);
    await save('status.json', {state: 'starting'});
    await chmod(path.join(dir, 'credentials.json'), 0o644);
    const denied = await start().ended;
    assert.match(denied.stdout, /background_file_permissions/);
    assert.equal(await readFile(marker, 'utf8'), calls);
    await chmod(path.join(dir, 'credentials.json'), 0o600);
    await save('status.json', {state: 'starting'});
    await writeFile(worker, body + '\n// drift');
    const drift = await start().ended;
    assert.match(drift.stdout, /background_runtime_changed/);
    assert.equal(await readFile(marker, 'utf8'), calls);
    await writeFile(worker, body);
    await save('status.json', {state: 'starting'});
    await writeFile(lock, 'changed');
    const changed = await start().ended;
    assert.match(changed.stdout, /background_dependencies_changed/);
    assert.equal(await readFile(marker, 'utf8'), calls);
    await save('control.json', {paused: true});
    const paused = await start().ended;
    assert.match(paused.stdout, /paused/);
    assert.equal(await readFile(marker, 'utf8'), calls);
    const report = {
      result: 'passed',
      directory: dir,
      live_slack: false,
      real_child_processes: true,
      checks: [
        'graceful child stop and PID absence',
        'status has no credentials',
        'stale/waiting/stopped/failed monitoring visible without a live coordinator',
        'failure latch prevents second launch',
        'unsafe secret permissions prevent launch',
        'frozen runtime/dependency drift prevents launch',
        'paused service remains stopped',
      ],
      unperformed: ['Actual launchd lifecycle', 'Sleep/login/reboot behavior'],
    };
    await save('report.json', report);
    t.diagnostic('Evidence: ' + path.join(dir, 'report.json'));
  },
);
