"""Real Browser Use actor API; deterministic synthetic fixture, no model or secrets."""
import asyncio
import json
import logging
import os
import urllib.request

os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_LOGGING_LEVEL'] = 'critical'
logging.disable(logging.CRITICAL)

from browser_use import Browser

FIXTURE = 'http://127.0.0.1:8730/fixture'

def state_sync():
    with urllib.request.urlopen(FIXTURE + '/status', timeout=5) as response:
        return json.load(response)

async def element(page, selector):
    for _ in range(50):
        elements = await page.get_elements_by_css_selector(selector)
        if elements:
            return elements[0]
        await asyncio.sleep(0.1)
    raise RuntimeError('Fixture element unavailable')

async def run():
    browser = Browser(cdp_url='http://127.0.0.1:9222', keep_alive=True, is_local=False)
    await browser.start()
    try:
        page = await browser.get_current_page()
        if page is None:
            raise RuntimeError('Chrome unavailable')
        await page.goto(FIXTURE)
        epoch = (await asyncio.to_thread(state_sync))['epoch']
        for _ in range(35):
            state = await asyncio.to_thread(state_sync)
            if state['epoch'] != epoch:
                raise RuntimeError('Fixture run replaced')
            if state['checkpoint'] == 3:
                return
            if state['checkpoint'] == 0:
                await (await element(page, '#fixture-user')).fill('matrix-lab')
                await (await element(page, '#fixture-password')).fill('synthetic-only')
                await (await element(page, '#fixture-login')).click()
            elif state['checkpoint'] == 1:
                await (await element(page, '#fixture-otp')).fill(state['otp'])
                await (await element(page, '#fixture-verify')).click()
            elif state['checkpoint'] == 2:
                await (await element(page, '#fixture-work')).click()
            else:
                raise RuntimeError('Fixture state invalid')
            await asyncio.sleep(0.9)
    finally:
        await browser.stop()  # Disconnect the attached session, preserving Chrome/profile.

if __name__ == '__main__':
    try:
        asyncio.run(asyncio.wait_for(run(), timeout=150))
    except Exception:
        raise SystemExit(1)
