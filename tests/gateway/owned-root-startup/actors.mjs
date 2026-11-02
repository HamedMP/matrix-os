/* Fixed synthetic Python negative actor. It is not Root or native policy. */
export const COPIED_REPLY = `#!/usr/bin/python3
import hashlib,json,os,socket,struct,time
from pathlib import Path
s=socket.socket(fileno=3); s.settimeout(5.5)
if os.sys.argv[1:]==['--matrix-private-server','3']:
 while s.recv(8192): pass
else:
 assert os.sys.argv[1:]==['--matrix-private-initializer','3']
 def exact(size):
  output=bytearray()
  while len(output)<size:
   data,anc,flags,_=s.recvmsg(size-len(output),128)
   assert data
   cred=[struct.unpack('3i',v) for level,kind,v in anc if level==socket.SOL_SOCKET and kind==socket.SCM_CREDENTIALS]
   assert cred==[(os.getppid(),os.getuid(),os.getgid())]
   output.extend(data)
  return bytes(output)
 magic,version,kind,reserved,size=struct.unpack('<8sBBHI',exact(16))
 assert (magic,version,kind,reserved)==(b'MXZPREP\\0',1,1,0) and size<=8176
 body=exact(size); correlation=body[:72]
 entries=sorted((k.encode(),v.encode()) for k,v in os.environ.items())
 assert len(entries)<=512
 environment=struct.pack('<H',len(entries))
 for key,value in entries:
  assert 0<len(key)<=256 and len(value)<=16384
  environment+=struct.pack('<H',len(key))+key+struct.pack('<H',len(value))+value
 payload=correlation+struct.pack('<Q',4)+environment+hashlib.sha256(b'matrix-private-env-v1\\0'+environment).digest()
 reply=struct.pack('<8sBBHI',b'MXZPREP\\0',1,2,0,len(payload))+payload
 ready_r,ready_w=os.pipe(); release_r,release_w=os.pipe()
 writer=os.fork()
 if writer==0:
  os.close(ready_r); os.close(release_w)
  try:
   s.sendall(reply); os.write(ready_w,b'W'); assert os.read(release_r,1)==b'Q'
  finally: os.close(ready_w); os.close(release_r); s.close()
  os._exit(0)
 os.close(ready_w); os.close(release_r)
 try:
  assert os.read(ready_r,1)==b'W'
  # I remains live with its own copied endpoint until producer fencing. B is
  # also retained by this actual fork owner; neither exits before native read.
  assert s.recv(1)==b''
 finally:
  try: os.write(release_w,b'Q')
  finally:
   os.close(release_w); os.close(ready_r)
   actual,status=os.waitpid(writer,0)
  assert actual==writer and os.waitstatus_to_exitcode(status)==0
  target=Path.cwd()/'copied-writer-reaped.json'
  target.write_text(json.dumps({'actualWait':True,'exit':0}))
`;
