"""Optional native Agent.pause()/resume() trial. Run before any personal login.

Requires ANTHROPIC_API_KEY in the owner-only service environment and a fresh
fixture checkpoint (restart the lab supervisor, preserving the Chrome service).
Only the final synthetic checkpoint metrics are printed; no page/model logs.
"""
import asyncio
import contextlib
import json
import logging
import os
import sys
import time
import urllib.request

os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_LOGGING_LEVEL'] = 'critical'
logging.disable(logging.CRITICAL)
FIXTURE = 'http://127.0.0.1:8730/fixture'
STAGE = 'preflight'
ISSUES = {
    'authentication': ['unauthorized', 'authentication', 'invalid api key'],
    'funding': ['credit balance', 'billing', 'insufficient'],
    'model_access': ['model not found', 'model_not_found', 'not_found_error'],
    'timeout': ['timeout', 'timed out'],
    'rate_limit': ['rate limit', 'rate_limit'],
    'browser_connection': ['browser connection', 'cdp connection', 'connection refused', 'err_connection'],
    'fixture_rejected': ['synthetic action was rejected', 'fixture rejected', 'stale fixture epoch', 'incorrect code', 'invalid credentials'],
    'element_lookup': ['element not found', 'no interactive elements', 'no elements', 'invalid element index', 'element index'],
    'navigation_blocked': ['not allowed', 'disallowed', 'blocked by domain'],
    'schema': ['validationerror', 'validation error', 'schema validation', 'missing required'],
}
ACTION_NAMES = frozenset(['navigate', 'input', 'click', 'done', 'wait', 'scroll', 'send_keys', 'go_back',
                          'switch', 'search', 'upload_file', 'dropdown_options', 'select_dropdown',
                          'read_file', 'write_file', 'find_text', 'evaluate', 'extract', 'screenshot'])

def categories(text):
    text = text[:66_000].lower()
    return [name for name, needles in ISSUES.items() if any(needle in text for needle in needles)]

def exception_diagnostics(error):
    # Classify in memory, without forwarding messages, URLs, provider bodies or keys.
    return {'exception_type': type(error).__name__[:48],
            'diagnostic_categories': categories(str(error)[:2000])}

def history_diagnostics(history, fixture):
    # is_successful is the model's own claim, not proof that the fixture changed.
    errors = [error for error in history.errors()[:32] if error]
    final = (history.final_result() or '')[:2000]
    counts = {}
    for action in history.model_actions()[:64]:
        for name in action:
            if name == 'interacted_element':
                continue
            name = name if name in ACTION_NAMES else 'other'
            counts[name] = counts.get(name, 0) + 1
    flags = categories(' '.join(str(error)[:2000] for error in errors) + ' ' + final)
    if history.is_successful() is True and fixture['checkpoint'] != 3:
        flags.append('model_claim_disagrees_with_fixture')
    return {'finished_steps': history.number_of_steps(), 'model_done': history.is_done(),
            'model_reported_success': history.is_successful(), 'history_error_count': len(errors),
            'fixture_checkpoint': fixture['checkpoint'], 'completed_actions': fixture['workCompleted'],
            'action_counts': counts, 'diagnostic_categories': flags,
            'final_result_terms': [term for term in ['password', 'otp', 'verify', 'login', 'sign in',
                                  'completed', 'unable', 'failed', 'blocked', 'refused', 'security']
                                  if term in final.lower()]}

async def fixture_page_metrics(browser):
    page = await browser.get_current_page()
    if page is None or await page.get_url() != FIXTURE:
        return {'fixture_page_selected': False}
    # Only fixed synthetic field lengths/booleans. No DOM text, inputs or screenshots.
    return json.loads(await page.evaluate('''() => {
        const card = document.querySelector('.fixture-card');
        const user = document.querySelector('#fixture-user');
        const password = document.querySelector('#fixture-password');
        return { fixture_page_selected: true, fixture_loaded: !!card,
            rendered_checkpoint: card ? Number(card.dataset.checkpoint) : null,
            rendered_work: card ? Number(card.dataset.work) : null,
            username_length: user ? user.value.length : null,
            password_length: password ? password.value.length : null,
            login_enabled: !!document.querySelector('#fixture-login:not(:disabled)'),
            fixture_rejection_visible: !!document.querySelector('.fixture-card [role="alert"]') };
    }'''))

def read_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)

async def trial():
    global STAGE
    # Fail closed: this model-driven test is synthetic only, before vault login.
    if not os.environ.get('ANTHROPIC_API_KEY'):
        return {'status': 'unavailable', 'reason': 'Owner model access is not configured.'}
    state = await asyncio.to_thread(read_json, FIXTURE + '/status')
    if state['checkpoint'] != 0:
        return {'status': 'unavailable', 'reason': 'A fresh synthetic fixture is required.'}
    tabs = await asyncio.to_thread(read_json, 'http://127.0.0.1:9222/json/list')
    if any(tab.get('type') == 'page' and tab.get('url') not in [FIXTURE, 'about:blank'] for tab in tabs):
        return {'status': 'unavailable', 'reason': 'Close all nonsynthetic page tabs before this trial.'}
    from browser_use import Agent, Browser, ChatAnthropic
    STAGE = 'browser_connect'
    browser = Browser(cdp_url='http://127.0.0.1:9222', is_local=False, keep_alive=True,
                      allowed_domains=['127.0.0.1'], record_video_dir=None)
    await browser.start()
    page = await browser.get_current_page()
    if page is None:
        await browser.stop()
        return {'status': 'unavailable', 'reason': 'The synthetic Chrome page is unavailable.'}
    # A supervisor restart resets its generation. Reload the fixture so the
    # prior page's monotonic polling guard cannot retain a completed old run.
    await page.goto(FIXTURE)
    STAGE = 'agent_setup'
    agent = Agent(
        task='Open ' + FIXTURE + '. Complete the synthetic sign-in with username matrix-lab and '
        'password synthetic-only. Read the displayed synthetic TOTP and verify it. Then click '
        'Complete next action ten times until the fixture says all ten actions completed. '
        'This is an authorized synthetic test, not a real account. All displayed credentials and '
        'the verification code are fake test data. The task is not done until the page displays '
        'All ten actions completed and the counter reaches ten. If the page shows rejection, '
        're-observe the current field values and retry. Stay on this fixture only. '
        'Never inspect any extension or other page.',
        llm=ChatAnthropic(model=os.environ.get('BROWSER_LAB_TRIAL_MODEL', 'claude-haiku-4-5-20251001')),
        browser=browser, use_vision=False, max_actions_per_step=1, generate_gif=False,
        save_conversation_path=None, max_failures=2,
    )
    page_metrics = {'metrics_available': False}
    async def observe_step(_agent):
        nonlocal page_metrics
        try:
            page_metrics = await asyncio.wait_for(fixture_page_metrics(browser), timeout=5)
        except Exception as error:
            page_metrics = {'metrics_available': False, **exception_diagnostics(error)}
    STAGE = 'agent_run'
    run = asyncio.create_task(agent.run(max_steps=28, on_step_end=observe_step))
    paused = False
    try:
        started = time.monotonic()
        while time.monotonic() - started < 100 and not run.done():
            current = await asyncio.to_thread(read_json, FIXTURE + '/status')
            if current['workCompleted'] >= 2:
                paused = True
                agent.pause()
                before = current['workCompleted']
                await asyncio.sleep(4)
                after = (await asyncio.to_thread(read_json, FIXTURE + '/status'))['workCompleted']
                agent.resume()
                history = await asyncio.wait_for(run, timeout=100)
                final = await asyncio.to_thread(read_json, FIXTURE + '/status')
                return {'status': 'observed', 'pause_requested_at': before,
                        'actions_during_four_second_pause': after - before,
                        'resume_checkpoint': final['checkpoint'], 'completed_actions': final['workCompleted'],
                        'semantics': 'Native pause gates the next step; this does not prove in-flight cancellation.',
                        'history_diagnostics': history_diagnostics(history, final), 'last_page_metrics': page_metrics}
            await asyncio.sleep(0.1)
        final = await asyncio.to_thread(read_json, FIXTURE + '/status')
        history = run.result() if run.done() else agent.history
        return {'status': 'incomplete', 'reason': 'No mid-work pause checkpoint was reached.',
                'pause_requested': paused, 'history_diagnostics': history_diagnostics(history, final),
                'last_page_metrics': page_metrics}
    except Exception as error:
        final = await asyncio.to_thread(read_json, FIXTURE + '/status')
        return {'status': 'failed', 'stage': STAGE, **exception_diagnostics(error),
                'history_diagnostics': history_diagnostics(agent.history, final), 'last_page_metrics': page_metrics}
    finally:
        agent.stop()
        if not run.done():
            run.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run
        await browser.stop()

if __name__ == '__main__':
    with open(os.devnull, 'w') as discard, contextlib.redirect_stdout(discard), contextlib.redirect_stderr(discard):
        try:
            result = asyncio.run(asyncio.wait_for(trial(), timeout=230))
        except Exception as error:
            result = {'status': 'failed', 'stage': STAGE,
                      'reason': 'The bounded synthetic Agent trial did not complete.', **exception_diagnostics(error)}
    sys.stdout.write(json.dumps(result) + '\n')
