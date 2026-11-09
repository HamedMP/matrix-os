import type {ChatAgentClient} from "../chat-agents/client.js";
import {chatAgentButtonClass} from "../chat-agents/theme.js";
import {useRoutineDestinationPicker} from "./use-routine-destination-picker.js";
export function PersistentTaskControl({selected,onChange,client,disabled=false}:{selected:boolean;onChange:(value:boolean)=>void;client?:ChatAgentClient;disabled?:boolean}) {
 const destination=useRoutineDestinationPicker(client,selected);
 return <div className="grid min-w-0 gap-2 text-xs"><button type="button" aria-pressed={selected} disabled={disabled} className="rounded-md border px-2 py-1" onClick={()=>onChange(!selected)}>Persistent task</button>
  {selected?<><p>Runs as a Matrix routine. Review and results stay in this Chat.</p>
   {destination.view?.availability==="available"?<p>Existing Bot destination selected.</p>:<label>Existing private Bot Chat<select aria-label="Routine destination" disabled={destination.pending} value="" onChange={event=>void destination.choose(event.currentTarget.value)}><option value="">Choose an existing Bot Chat</option>{destination.candidates.map(item=><option key={item.botId} value={item.botId}>{item.name}</option>)}</select></label>}
   {destination.error?<p role="alert">{destination.error}</p>:null}
   {!destination.pending&&!destination.candidates.length&&destination.view?.availability!=="available"?<p>No eligible existing Bot Chat is available. Select an existing private Bot in Agents.</p>:null}
   {destination.error?<button type="button" className={`${chatAgentButtonClass} justify-self-start`} onClick={()=>void destination.refresh()}>Refresh destination</button>:null}
  </>:null}
 </div>;
}
