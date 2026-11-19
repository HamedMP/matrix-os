"""Read-only verification of the installed immutable controller protections."""
import json, subprocess
PIN = 'bc47e8e3623898f83c946d13f0689e572b9a3821'
OLD = '17a8781015e1c623f7203297480362e6a7a73429'
REPO = 'repos/HamedMP/matrix-os/'
BRANCH = 'preview-pair-controller/' + PIN
def get(path):
    result = subprocess.run(['gh','api',REPO + path], capture_output=True, text=True, timeout=30)
    if result.returncode: raise RuntimeError('Required GitHub protection metadata unavailable')
    return json.loads(result.stdout)
def main():
    if get('git/ref/heads/' + BRANCH)['object']['sha'] != PIN: raise ValueError('Controller ref mismatch')
    for kind in ['control','build']:
        path = 'environments/collaboration-preview-' + kind
        env = get(path)
        if env.get('deployment_branch_policy') != {'protected_branches':False,'custom_branch_policies':True}: raise ValueError('Unexpected environment policy')
        rows = get(path + '/deployment-branch-policies?per_page=100')
        policies = rows['branch_policies']
        if rows.get('total_count') != 1 or len(policies)!=1 or policies[0]['name']!=BRANCH or policies[0].get('type','branch')!='branch': raise ValueError('Environment allows an unexpected ref')
        if kind == 'control':
            reviews = [r for r in env.get('protection_rules',[]) if r['type']=='required_reviewers']
            if len(reviews)!=1 or len(reviews[0].get('reviewers',[]))!=2: raise ValueError('Required reviewers differ; inspect manually')
            # Normal self-review is explicitly authorized for this test.
    rules = get('rulesets/27310115')
    wanted = ['refs/heads/preview-pair-controller/' + pin for pin in [OLD,PIN]]
    refs = rules['conditions']['ref_name']
    if rules.get('target')!='branch' or rules.get('enforcement')!='active' or rules.get('bypass_actors') or refs.get('exclude') or sorted(refs.get('include',[]))!=sorted(wanted): raise ValueError('Controller ruleset differs')
    if sorted(r['type'] for r in rules['rules'])!=['deletion','non_fast_forward','update'] or any(r.get('parameters',{}).get('update_allows_fetch_and_merge') for r in rules['rules']): raise ValueError('Controller blocking rules differ')
    if get('actions/variables/MATRIX_PREVIEW_PAIR_CONTROLLER_SHA')['value']!=PIN: raise ValueError('Repository controller pin differs')
    print('Verified installed controller ref, both environment branch policies, reviewers, ruleset and repository pin. No writes.')
if __name__ == '__main__': main()
