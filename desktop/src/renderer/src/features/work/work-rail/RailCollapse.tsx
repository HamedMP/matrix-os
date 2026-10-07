import type { ReactNode } from "react";
export function RailCollapse({expanded,children,className=""}:{expanded:boolean;children:ReactNode;className?:string}) {
  return <div aria-hidden={!expanded} inert={!expanded} data-slot="chat-rail-collapse" data-expanded={expanded} className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none" style={{gridTemplateRows:expanded ? "1fr" : "0fr",opacity:expanded ? 1 : 0}}>
    <div className="min-h-0 overflow-hidden"><div className={className}>{children}</div></div>
  </div>;
}
