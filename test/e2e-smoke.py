"""Isolated OpenCode server + TUI smoke test driving the rewind RPCs over HTTP.

Uses a temporary home, project and a scripted local model (test/mock_model.py) that requests
real OpenCode tools. No user configuration or real project is touched.
  python3 test/e2e-smoke.py --background --mock-model   # same-file background-subagent rewind/undo
  python3 test/e2e-smoke.py --deletion --mock-model     # fork + session deletion reclaims refs
"""
import base64
import fcntl
import http.server
import json
import os
import pathlib
import pty
import secrets
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.request
import mock_model

PLUGIN = pathlib.Path(__file__).resolve().parents[1]
BACKGROUND = '--background' in sys.argv
DELETION = '--deletion' in sys.argv

with tempfile.TemporaryDirectory(prefix='rewind-e2e-') as tmp:
    base = pathlib.Path(tmp)
    project = base / 'project'
    project.mkdir()
    subprocess.run(['git', 'init', '-q'], cwd=project, check=True)
    gate = None
    mock = mock_model.start()
    gate_release, gate_enter = threading.Event(), threading.Event()
    gate_data = {}
    plugins = [str(PLUGIN)]
    if BACKGROUND:
        class Gate(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                gate_data.update(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                gate_enter.set()
                released = gate_release.wait(90)
                self.send_response(200 if released else 503)
                self.end_headers()
                try: self.wfile.write(b'ok')
                except BrokenPipeError: pass
            def log_message(self, *args): pass
        gate = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Gate)
        threading.Thread(target=gate.serve_forever, daemon=True).start()
        gate_plugin = base / 'gate-plugin'
        gate_plugin.mkdir()
        (gate_plugin / 'index.js').write_text('''export default {id:'rewind-test-gate',async setup(ctx){
          await ctx.tool.hook('execute.before',async e=>{
            if(e.agent!=='rewind-writer'||!['edit','write'].includes(e.tool)) return;
            await fetch('http://127.0.0.1:%d/gate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionID:e.sessionID,agent:e.agent,tool:e.tool})});
          });
        }};''' % gate.server_port)
        plugins.append(str(gate_plugin))
    config = {'plugins': plugins}
    config['providers'] = {'rewind-local': {'name': 'Rewind local test', 'package': '@opencode/ai/providers/openai-compatible',
          'settings': {'baseURL': 'http://127.0.0.1:%d/v1' % mock.server_port},
          'models': {'rewind-test': {'modelID': 'rewind-test', 'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']},
                                    'limit': {'context': 32768, 'output': 8192}}}}}
    if BACKGROUND:
        config['agents'] = {'rewind-writer': {
            'description': 'Edit target.txt as requested by the parent',
            'mode': 'subagent',
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'allow'}]
        }}
    (project / 'opencode.json').write_text(json.dumps(config))
    (project / 'target.txt').write_text('before\n')
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(('OPENCODE_', 'GIT_')):
            env.pop(key)
    password = secrets.token_urlsafe(32)
    env.update(HOME=str(base / 'home'), XDG_CONFIG_HOME=str(base / 'config'),
               XDG_DATA_HOME=str(base / 'data'), XDG_CACHE_HOME=str(base / 'cache'),
               XDG_STATE_HOME=str(base / 'state'), GIT_CONFIG_GLOBAL='/dev/null',
               GIT_CONFIG_SYSTEM='/dev/null', OPENCODE_PASSWORD=password, TERM='xterm-256color')
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    origin = 'http://127.0.0.1:' + str(port)
    headers = {'Authorization': 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode(),
               'Content-Type': 'application/json'}
    server = tui = None
    master = None

    def request(method, route, body=None, timeout=20):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(origin + route, method=method, headers=headers, data=data)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if '/api/rpc/opencode-rewind/' in route:
                print('RPC failure', route.rsplit('/', 1)[-1], 'HTTP', error.code)
            raise

    def rpc(name, body):
        result = request('POST', '/api/rpc/opencode-rewind/' + name, {'input': body})
        if 'data' in result:
            return result['data']
        if 'output' in result:
            return result['output']
        raise RuntimeError('unexpected RPC response keys: ' + ','.join(sorted(result)))

    try:
        server = subprocess.Popen(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                                  cwd=project, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  start_new_session=True)
        deadline = time.monotonic() + 30
        while True:
            if server.poll() is not None:
                raise RuntimeError('server exited before ready')
            try:
                models = request('GET', '/api/model', timeout=2)['data']
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() > deadline:
                    raise RuntimeError('server did not become ready')
                time.sleep(.2)
        print('CHECK server_ready')
        selected = next((m for m in models if m.get('providerID') == 'rewind-local' and m.get('id') == 'rewind-test' and m.get('enabled')), None)
        if not selected:
            raise RuntimeError('isolated mock model not available')
        print('CHECK model', selected['providerID'], selected['id'])
        if BACKGROUND:
            agents = request('GET', '/api/agent')['data']
            modes = {a['id']: a['mode'] for a in agents}
            print('CHECK builtin_build_mode', modes.get('build'))
            print('CHECK writer_mode', modes.get('rewind-writer'))
            if modes.get('rewind-writer') != 'subagent':
                raise RuntimeError('isolated writer was not loaded as a subagent')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        tui = subprocess.Popen(['opencode', '--server', origin], cwd=project, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        def drain():
            try:
                while os.read(master, 65536):
                    pass
            except OSError:
                pass
        threading.Thread(target=drain, daemon=True).start()
        time.sleep(3)
        session = request('POST', '/api/session', {'title': 'isolated rewind smoke', 'model': {'providerID': selected['providerID'], 'id': selected['id']}, 'permissions': [{'action': '*', 'resource': '*', 'effect': 'allow'}]})['data']['id']
        message = None
        for attempt in range(8):
            if tui.poll() is not None:
                raise RuntimeError('TUI exited before checkpoint observation')
            message = request('POST', '/api/session/' + session + '/prompt',
                              {'text': 'Reply exactly OK. Do not use tools.'})['data']['id']
            request('POST', '/api/experimental/session/' + session + '/wait', timeout=90)
            state = rpc('checkpoint', {'sessionID': session, 'messageID': message})
            if state.get('status') == 'available':
                break
            time.sleep(1)
        else:
            raise RuntimeError('TUI did not produce an available checkpoint: ' + str(state))
        print('CHECK actual_tui_idle_checkpoint')
        (project / 'target.txt').write_text('after\n')
        prepared = rpc('prepare', {'sessionID': session, 'messageID': message})
        assert any(c['name'] == 'target.txt' and c['action'] == 'modify' for c in prepared['changes'])
        target = rpc('begin', {'token': prepared['token']})
        request('POST', '/api/session/' + target['sessionID'] + '/revert/stage',
                {'messageID': target['messageID'], 'files': False})
        assert rpc('finish', {'token': prepared['token']})['success']
        assert (project / 'target.txt').read_text() == 'before\n'
        print('CHECK rewind_files_and_stage')
        assert rpc('beginUndo', {'sessionID': session})['success']
        assert (project / 'target.txt').read_text() == 'after\n'
        request('DELETE', '/api/session/' + session + '/revert')
        print('CHECK file_after_host_clear', repr((project / 'target.txt').read_text()))
        assert rpc('finishUndo', {'sessionID': session})['success']
        assert (project / 'target.txt').read_text() == 'after\n'
        print('CHECK undo_files_and_conversation')
        if DELETION:
            stores = list((base / 'data' / 'opencode' / 'rewind').glob('*/objects.git'))
            if len(stores) != 1:
                raise RuntimeError('isolated snapshot store not found')
            def refs():
                out = subprocess.check_output(['git', '--git-dir', str(stores[0]), 'for-each-ref', '--format=%(refname)', 'refs/rewind/'], text=True)
                return set(out.split())
            fork = request('POST', '/api/session/' + session + '/fork', {})['data']
            if fork.get('fork', {}).get('sessionID') != session:
                raise RuntimeError('host did not report fork ownership')
            print('CHECK actual_fork_created')
            inherited = [m for m in request('GET', '/api/session/' + fork['id'] + '/message?order=asc')['data'] if m.get('type') == 'user']
            if not inherited or any(rpc('checkpoint', {'sessionID': fork['id'], 'messageID': m['id']})['status'] != 'unavailable' for m in inherited):
                raise RuntimeError('fork inherited a file checkpoint')
            print('CHECK fork_inherits_no_file_checkpoints', len(inherited))
            parent_refs = refs()
            if not parent_refs:
                raise RuntimeError('parent has no checkpoint refs to reclaim')
            fork_message = request('POST', '/api/session/' + fork['id'] + '/prompt', {'text': 'Reply exactly OK. Do not use tools.'})['data']['id']
            request('POST', '/api/experimental/session/' + fork['id'] + '/wait', timeout=90)
            fork_available = rpc('checkpoint', {'sessionID': fork['id'], 'messageID': fork_message})['status'] == 'available'
            fork_refs = refs() - parent_refs
            if len(fork_refs) != (1 if fork_available else 0):
                raise RuntimeError('unexpected fork checkpoint refs')
            print('CHECK fork_own_prompt_checkpoint', 'available' if fork_available else 'unavailable', 'refs', len(fork_refs))
            # Leave the parent with a staged rewind; deleting it must drop that journal too.
            prepared = rpc('prepare', {'sessionID': session, 'messageID': message})
            staged = rpc('begin', {'token': prepared['token']})
            request('POST', '/api/session/' + session + '/revert/stage', {'messageID': staged['messageID'], 'files': False})
            assert rpc('finish', {'token': prepared['token']})['success']
            assert 'journal: staged' in rpc('inspect', {})['message']
            print('CHECK parent_left_with_staged_rewind_journal')
            request('DELETE', '/api/session/' + session)
            deadline = time.monotonic() + 15
            while refs() != fork_refs:
                if time.monotonic() >= deadline:
                    raise RuntimeError('parent refs were not reclaimed: %d remain' % len(refs() - fork_refs))
                time.sleep(.1)
            assert rpc('checkpoint', {'sessionID': session, 'messageID': message})['status'] == 'unavailable'
            assert request('GET', '/api/session/' + fork['id'])['data']['id'] == fork['id']
            if fork_available:
                assert rpc('checkpoint', {'sessionID': fork['id'], 'messageID': fork_message})['status'] == 'available'
            deadline = time.monotonic() + 15
            while ' 0 pending,' not in (inspection := rpc('inspect', {})['message']):
                if time.monotonic() >= deadline:
                    raise RuntimeError('reclaim did not settle: ' + inspection)
                time.sleep(.1)
            assert 'journal: none' in inspection and 'lifecycle: ok' in inspection
            print('CHECK actual_deletion_reclaimed_parent_refs', len(parent_refs), 'kept_fork_refs', len(fork_refs), 'journal_dropped')
            print('CHECK inspection', inspection.split(';')[1].strip())
            unreachable = subprocess.check_output(['git', '--git-dir', str(stores[0]), 'fsck', '--unreachable', '--no-reflogs'], text=True, stderr=subprocess.DEVNULL)
            print('CHECK unreachable_objects_kept_within_1h_grace', len(unreachable.splitlines()))
        if BACKGROUND:
            background_message = request('POST', '/api/session/' + session + '/prompt', {
                'text': 'Use the subagent tool exactly once with agent rewind-writer and background true. Ask the child to use the edit or write tool to replace target.txt contents with exactly: child changed\n. Do not edit files yourself. After launching it respond OK.'
            })['data']['id']
            if not gate_enter.wait(75):
                raise RuntimeError('background child did not reach the edit/write barrier')
            child = gate_data['sessionID']
            if gate_data.get('agent') != 'rewind-writer':
                raise RuntimeError('barrier observed the wrong agent')
            print('CHECK barrier_agent', gate_data['agent'], 'tool', gate_data['tool'])
            children = request('GET', '/api/session?parentID=' + session)['data']
            if not any(c.get('id') == child and c.get('parentID') == session for c in children):
                raise RuntimeError('active child was not linked to the parent session')
            timeline = request('GET', '/api/session/' + session + '/message?order=asc')['data']
            subagent_calls = [part for msg in timeline for part in msg.get('content', [])
                              if isinstance(part, dict) and part.get('type') == 'tool' and part.get('name') == 'subagent']
            if not any(part.get('state', {}).get('input', {}).get('background') is True and part.get('state', {}).get('input', {}).get('agent') == 'rewind-writer' for part in subagent_calls):
                raise RuntimeError('parent timeline does not show the real background subagent call')
            print('CHECK real_background_subagent_tool_and_parent_link')
            active = request('GET', '/api/session/active')['data']
            if not active.get(child):
                raise RuntimeError('barrier session not observed active')
            print('CHECK real_background_child_active_at_write_barrier')
            during = request('POST', '/api/session/' + session + '/prompt', {'text': 'observe child', 'resume': False})['data']['id']
            availability = rpc('checkpoint', {'sessionID': session, 'messageID': during})
            if availability['status'] != 'unavailable':
                raise RuntimeError('active child was not marked unavailable')
            print('CHECK active_child_checkpoint_unavailable')
            gate_release.set()
            request('POST', '/api/experimental/session/' + child + '/wait', timeout=90)
            request('POST', '/api/experimental/session/' + session + '/wait', timeout=90)
            if (project / 'target.txt').read_text() == 'after\n':
                raise RuntimeError('child did not change the same target file')
            child_content = (project / 'target.txt').read_text()
            if child_content != 'child changed\n':
                raise RuntimeError('child did not produce the scripted file contents')
            print('CHECK background_child_changed_same_file')
            if rpc('checkpoint', {'sessionID': session, 'messageID': background_message})['status'] != 'available':
                raise RuntimeError('parent checkpoint before background work unavailable')
            prepared = rpc('prepare', {'sessionID': session, 'messageID': background_message})
            target = rpc('begin', {'token': prepared['token']})
            request('POST', '/api/session/' + target['sessionID'] + '/revert/stage', {'messageID': target['messageID'], 'files': False})
            assert rpc('finish', {'token': prepared['token']})['success']
            assert (project / 'target.txt').read_text() == 'after\n'
            assert request('GET', '/api/session/' + session)['data']['revert']['messageID'] == background_message
            print('CHECK background_same_file_rollback')
            assert rpc('beginUndo', {'sessionID': session})['success']
            request('DELETE', '/api/session/' + session + '/revert')
            assert rpc('finishUndo', {'sessionID': session})['success']
            assert (project / 'target.txt').read_text() == child_content
            assert not request('GET', '/api/session/' + session)['data'].get('revert')
            print('CHECK background_same_file_undo')
    finally:
        gate_release.set()
        if gate:
            gate.shutdown()
            gate.server_close()
        for proc in (tui, server):
            if proc and proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
        if master is not None:
            os.close(master)
        mock.shutdown()
        mock.server_close()
        print('CHECK isolated_process_cleanup')
