import {BotRoutineDetailResponseSchema,type BotRoutineCenterItem} from "@matrix-os/contracts";

export function routineMessageFixture(chatId="chat_owner",suffix="a",overrides:Partial<BotRoutineCenterItem>={}){
  const fire={fireId:"fire_"+suffix.repeat(24),taskId:"task_"+suffix.repeat(24),scheduledFor:"2026-11-02T01:00:00Z",status:"failed",attempts:0,failureCode:"background_not_authorized",updatedAt:"2026-11-02T01:00:01Z"};
  return BotRoutineDetailResponseSchema.parse({routine:{routineId:"rt_"+suffix.repeat(24),botId:"bot_meeting01",chatId,
    proposal:{name:"Saved task",prompt:"Return READY.",schedule:{kind:"cron",expr:"* * * * *",tz:"Asia/Shanghai"},selection:{instanceId:"matrix_chatgpt_plan",model:"gpt-6-luna"},authorizedEffects:["read"]},
    status:"archived",revision:1,nextFireAt:null,computerId:"Preview",requiresReview:false,targetAvailable:false,sourceAvailable:false,lastFire:fire,...overrides},history:[fire]});
}
