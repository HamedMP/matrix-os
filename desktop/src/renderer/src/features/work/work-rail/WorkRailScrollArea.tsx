import { useEffect, useRef, useState, type ReactNode } from "react";
import "./work-rail.css";
export function WorkRailScrollArea({children}:{children:ReactNode}) {
  const [scrolling,setScrolling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  return <div data-testid="work-rail-scroll" data-scrolling={scrolling} className="work-rail-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2" onScroll={()=> {
    setScrolling(true);
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>setScrolling(false),700);
  }}>{children}</div>;
}
