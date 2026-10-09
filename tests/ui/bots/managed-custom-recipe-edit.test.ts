import { expect, it } from 'vitest';
import { recoverCreatedCustomBot } from '../../../packages/ui/src/chat-agents/recover-created-custom-bot.js';
import { clientFixture } from '../../desktop/chat-agents-fixture.js';
import { agentRecipePatch } from '../../../packages/ui/src/chat-agents/recipe-edit.js';
import { saved } from '../../desktop/chat-agents-fixture.js';

it('persists custom coordinator recipe edits while preserving fixed server recipe definitions', () => {
 const original={skills:[],integrations:[],output:'A short answer'};
 const recipe={...original,output:'A revised answer'};
 const managed={...saved,recipeRef:{recipeId:'custom-coordinator',version:'1'},recipe:original};
 expect(agentRecipePatch(managed,recipe)).toEqual({recipe});
 expect(agentRecipePatch({...managed,recipeRef:{recipeId:'writing-bot',version:'1'}},recipe)).toEqual({});
 expect(agentRecipePatch(managed,null)).toEqual({recipe:null});
});

it('keeps recipe-free recovery and unchanged recipes free of incidental writes', async () => {
 const agent={...saved,recipeRef:{recipeId:'custom-coordinator',version:'1'}};
 const client=clientFixture();
 const created={agent:{id:agent.id,name:agent.name,avatarSeed:'a'.repeat(32),revision:1,status:'active' as const},chatId:'chat_recovery01',operation:'created' as const};
 const draft={name:agent.name,description:agent.description,instructions:agent.instructions,selection:agent.selection,requestId:'req_recovery01'};
 client.list.mockResolvedValue({enabled:true,agents:[agent]});
 expect(await recoverCreatedCustomBot(client,created,draft)).toEqual(agent);
 expect(client.update).not.toHaveBeenCalled();
 const recipe={skills:[],integrations:[],output:'A short answer'};
 const withRecipe={...agent,recipe};
 client.list.mockResolvedValue({enabled:true,agents:[withRecipe]});
 expect(await recoverCreatedCustomBot(client,created,{...draft,recipe})).toEqual(withRecipe);
 expect(client.update).not.toHaveBeenCalled();
 // The ordinary editing helper still interprets omitted recipe as no edit.
 expect(agentRecipePatch(withRecipe,undefined)).toEqual({});
});
