"""Scripted OpenAI-compatible model; all OpenCode tools remain real."""
import http.server
import json
import threading
import time


def start():
    issued = set()
    lock = threading.Lock()
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            messages = request.get('messages', [])
            tools = {t.get('function', {}).get('name'): t.get('function', {}).get('parameters') for t in request.get('tools', [])}
            text = json.dumps(messages)
            after_tool = bool(messages and messages[-1].get('role') == 'tool')
            function = None
            with lock:
                if not after_tool and 'Use the subagent tool exactly once' in text and 'subagent' in tools and 'subagent' not in issued:
                    issued.add('subagent')
                    function = ('subagent', {'agent': 'rewind-writer', 'description': 'Edit the target file', 'background': True,
                                             'prompt': 'Replace target.txt with exactly child changed followed by a newline. Use the write tool.'})
                elif not after_tool and 'Replace target.txt with exactly child changed' in text and 'write' in tools and 'write' not in issued:
                    issued.add('write')
                    function = ('write', {'path': 'target.txt', 'content': 'child changed\n'})
            if function:
                print('CHECK mock_requested_real_tool', function[0], flush=True)
            common = {'id': 'chatcmpl-rewind', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'rewind-test'}
            chunks = [dict(common, choices=[{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}])]
            if function:
                name, args = function
                chunks.append(dict(common, choices=[{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'call_rewind', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}, 'finish_reason': None}]))
                finish = 'tool_calls'
            else:
                chunks.append(dict(common, choices=[{'index': 0, 'delta': {'content': 'OK'}, 'finish_reason': None}]))
                finish = 'stop'
            chunks.append(dict(common, choices=[{'index': 0, 'delta': {}, 'finish_reason': finish}], usage={'prompt_tokens': 100, 'completion_tokens': 10, 'total_tokens': 110}))
            body = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(body.encode())))
            self.end_headers()
            self.wfile.write(body.encode())
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
