/** Fixed read-only JXA. Inputs arrive as data in argv; never interpolate script source. */
export const MEMORY_IMPORT_SCRIPT = String.raw`
function run(argv) {
 var request=JSON.parse(argv[0]), provider=request.provider, action=request.action, input=request.input;
 var app=Application(provider==='notes'?'Notes':provider==='mail'?'Mail':'Calendar');
 var collections=[], targets=[], accounts=[], warnings=[], records=[], bytes=0, full=false;
 function warn(value){if(warnings.indexOf(value)<0&&warnings.length<20)warnings.push(value);}
 function addCollection(id,label,object,account){if(collections.length>=100){warn('Only the first 100 collections are available in this trial.');return;}collections.push({id:String(id),label:String(label).slice(0,256)});targets.push(object);accounts.push(account);}
 function walk(parent,prefix,account,depth){if(depth>8||collections.length>=100){warn('Some nested collections are omitted from this bounded trial.');return;}var list=provider==='notes'?parent.folders:parent.mailboxes;var count=Math.min(list.length,100);for(var i=0;i<count&&collections.length<100;i++){var folder=list.at(i),name=String(folder.name()),path=prefix?prefix+' / '+name:name;addCollection(provider==='notes'?folder.id():JSON.stringify([account,path]),path,folder,account);walk(folder,path,account,depth+1);}}
 if(provider==='calendar'){for(var i=0;i<Math.min(app.calendars.length,100);i++){var c=app.calendars.at(i);addCollection(c.calendarIdentifier(),c.name(),c);}}
 else {for(var i=0;i<Math.min(app.accounts.length,100)&&collections.length<100;i++){var account=app.accounts.at(i);walk(account,String(account.name()),String(account.id()),0);}if(provider==='mail')walk(app,'On My Mac','local',0);}
 if(action==='inventory')return JSON.stringify({collections:collections,warnings:warnings});
 function date(value){return value instanceof Date&&!isNaN(value.getTime())?value.toISOString():undefined;}
 function take(record){if(!record.content.trim()){warn('Empty items were omitted.');return;}if(record.content.length>65536){warn('Items larger than 64 KB were omitted; use a separate export.');return;}if(bytes+record.content.length>1000000){full=true;warn('Preview reached the content size limit. Remaining items were omitted; narrow your selection for another preview.');return;}if(record.externalId.length>512){warn('Items with identifiers beyond the supported limit were omitted.');return;}if(records.some(function(existing){return existing.externalId===record.externalId;})){warn('Duplicate items were omitted.');return;}bytes+=record.content.length;record.title=String(record.title).slice(0,256);record.collection=String(record.collection).slice(0,200);records.push(record);}
 for(var t=0;t<collections.length&&records.length<input.limit&&!full;t++){
  if(input.collectionIds.indexOf(collections[t].id)<0)continue;
  var target=targets[t], items=provider==='notes'?target.notes:provider==='mail'?target.messages:target.events;
  if(provider==='calendar'&&input.from&&input.to)items=items.whose({_and:[{startDate:{_greaterThanEquals:new Date(input.from)}},{startDate:{_lessThanEquals:new Date(input.to)}}]});
  var count=Math.min(items.length,1000);if(items.length>1000)warn('Only the first 1,000 items in each selected collection were examined. Narrow the date range or use an export for complete coverage.');
  for(var j=0;j<count&&records.length<input.limit&&!full;j++){
   var item=items.at(j), occurred=provider==='notes'?date(item.modificationDate()):provider==='mail'?date(item.dateReceived()):date(item.startDate());
   if(input.from&&occurred&&occurred<input.from||input.to&&occurred&&occurred>input.to)continue;
   if(provider==='notes'){
    if(item.passwordProtected()){warn('Locked notes are omitted.');continue;}
    take({externalId:'notes:'+String(item.id()),title:String(item.name()||"Untitled note"),content:String(item.plaintext()),kind:'note',collection:collections[t].label,occurredAt:occurred,metadata:{attachmentsOmitted:"true"}});
   }else if(provider==='mail'){var messageId=String(item.messageId()||'').trim();if(!messageId)warn('Messages without a Message-ID use the app item ID; moving them may change their identity.');take({externalId:'mail:'+JSON.stringify([accounts[t],messageId?'message:'+messageId:'item:'+String(item.id())]),title:String(item.subject()||"Untitled email"),content:String(item.content()),kind:'email',collection:collections[t].label,occurredAt:occurred,metadata:{messageId:messageId,sender:String(item.sender()),attachmentsOmitted:"true"}});}
   else take({externalId:'calendar:'+collections[t].id+':'+String(item.uid()),title:String(item.summary()||'Calendar event'),content:[String(item.summary()||'Calendar event'),occurred,String(item.description()||''),String(item.location()||'')].join('\n'),kind:'calendar',collection:collections[t].label,occurredAt:occurred,metadata:{end:date(item.endDate())||'',recurrence:String(item.recurrence()||''),allDay:String(Boolean(item.alldayEvent())),attachmentsOmitted:"true"}});
  }
 }
 if(records.length>=input.limit)warn('Preview reached the selected item limit. This is a snapshot, not a complete sync.');
 warn('Attachments are omitted. No source app content is changed.');
 if(provider==='calendar')warn('Recurring events are imported as definitions; individual occurrences and original timezone identifiers are not exposed by this automation interface.');
 return JSON.stringify({records:records,warnings:warnings});
}
`;
