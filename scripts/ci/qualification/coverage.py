"""Exact source file and dynamic assertion count proof."""
import collections
from pathlib import PurePosixPath
def coverage(report,expected,phase):
 if phase not in ('unit','general','grid','electron') or not isinstance(report,dict) or report.get('success') is not True or report.get('numFailedTests')!=0 or report.get('numFailedTestSuites',0)!=0:raise ValueError('Complete report did not pass')
 if not isinstance(expected,list) or not 0<len(expected)<=10000 or len(set(expected))!=len(expected):raise ValueError('Invalid frozen inventory')
 files=report.get('testResults');paths=set();counts=collections.Counter()
 if not isinstance(files,list) or not 0<len(files)<=10000:raise ValueError('Invalid file results')
 for file in files:
  if not isinstance(file,dict) or file.get('status') not in ('passed','skipped'):raise ValueError('File did not pass')
  name=file.get('name')
  if not isinstance(name,str) or len(name)>4096 or not name.startswith(('/work/unit/' if phase=='unit' else '/work/e2e/')+'tests/'):raise ValueError('Wrong report root')
  path=name.removeprefix('/work/unit/' if phase=='unit' else '/work/e2e/')
  if path in paths or '..' in PurePosixPath(path).parts or '\\' in path:raise ValueError('Duplicate or invalid path')
  if phase=='unit':
   if path.startswith('tests/e2e/') or not path.endswith(('.test.ts','.test.tsx')):raise ValueError('Unexpected unit path')
  elif not path.startswith('tests/e2e/') or not path.endswith('.e2e.test.ts'):raise ValueError('Unexpected E2E path')
  paths.add(path);assertions=file.get('assertionResults')
  if not isinstance(assertions,list) or len(assertions)>100000:raise ValueError('Invalid assertion count')
  for assertion in assertions:
   if not isinstance(assertion,dict) or assertion.get('status') not in ('passed','skipped') or assertion.get('failureMessages'):raise ValueError('Assertion did not pass')
   if file['status']=='skipped' and assertion['status']!='skipped':raise ValueError('Skipped file contains active assertion')
   if any(not isinstance(assertion.get(k),str) or len(assertion[k])>256*1024 for k in ('title','fullName')):raise ValueError('Invalid assertion identity')
   ancestry=assertion.get('ancestorTitles')
   if not isinstance(ancestry,list) or len(ancestry)>100 or any(not isinstance(title,str) or len(title)>16384 for title in ancestry):raise ValueError('Invalid ancestry')
   counts[assertion['status']]+=1
   if sum(counts.values())>100000:raise ValueError('Case count exceeds bound')
 if paths!=set(expected):raise ValueError('Full source file inventory differs')
 if report.get('numTotalTests')!=sum(counts.values()) or report.get('numPassedTests')!=counts['passed'] or report.get('numPendingTests')!=counts['skipped']:raise ValueError('Report counts differ from assertions')
 return dict(files=len(paths),total=sum(counts.values()),passed=counts['passed'],skipped=counts['skipped'],failed=0)
