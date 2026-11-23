import {useState} from "react";
export function ScheduledInputText({text,scheduled}:{text:string;scheduled:boolean}) {
 const [expanded,setExpanded]=useState(false);const collapsible=scheduled&&(text.length>200||text.split("\n").length>3);
 return <><span className="whitespace-pre-wrap" style={collapsible&&!expanded?{display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden"}:undefined}>{text}</span>{collapsible?<button type="button" className="block text-xs underline" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?"Show less":"Show more"}</button>:null}</>;
}
