// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSitePanel } from "../../shell/src/components/app-sites/AppSitePanel";
import { SiteClientError, type SiteClient } from "../../shell/src/lib/site-client";

const published = { id: "11111111-1111-4111-8111-111111111111", appSlug: "launch", title: "Launch", description: "Join us", slug: "matrix-launch", url: "https://matrix.page/matrix-launch", revision: 1, status: "published" as const, accessMode: "public" as const, activeVersion: "22222222-2222-4222-8222-222222222222", versions: [{ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-09T12:00:00Z" }, { id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-10-08T12:00:00Z" }], config: { data: {}, forms: [] } };
function client(overrides: Partial<SiteClient> = {}): SiteClient {
  return { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => published), deploy: vi.fn(async () => published), update: vi.fn(async () => published), rollback: vi.fn(async () => published), unpublish: vi.fn(async () => ({ ...published, status: "unpublished" as const })), accessLinks: vi.fn(async () => ({ links: [], nextCursor: null })), createAccessLink: vi.fn(), revokeAccessLink: vi.fn(async () => undefined), emailInvitations: vi.fn(async () => ({ invitations: [], nextCursor: null, siteRevision: 1 })), createEmailInvitations: vi.fn(), resendEmailInvitation: vi.fn(), revokeEmailInvitation: vi.fn(), emailInvitationAudit: vi.fn(async () => ({ events: [], nextCursor: null })), submissions: vi.fn(async () => ({ submissions: [], nextCursor: null })), exportSubmissions: vi.fn(async () => new Blob(["[]"])), deleteSubmission: vi.fn(async () => undefined), ...overrides };
}
afterEach(cleanup);
describe("shared app publishing", () => {
  it("saves private link mode with the publication revision", async () => {
    const api=client({update:vi.fn(async()=>({...published,accessMode:"private_link" as const,revision:2}))});
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.change(screen.getByLabelText("Access"),{target:{value:"private_link"}});
    fireEvent.click(screen.getByRole("button",{name:"Save URL and details"}));
    await screen.findByText("Publication settings saved.");
    expect(api.update).toHaveBeenCalledWith("launch",expect.objectContaining({accessMode:"private_link",baseRevision:1}),expect.any(AbortSignal));
  });
  it("shows a generated private URL once, lists only metadata, and revokes a link", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,accessMode:"private_link" as const};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    const api=client({get:vi.fn(async()=>privateSite),accessLinks:vi.fn(async()=>({links:[],nextCursor:null})),createAccessLink:vi.fn(async()=>({link,url}))});
    render(<AppSitePanel appSlug="launch" client={api} />);
    const create=await screen.findByRole("button",{name:"Create one-time link"});
    await waitFor(()=>expect(create).toHaveProperty("disabled",false));
    fireEvent.click(create);
    const secretUrl=await screen.findByText(url);
    expect(secretUrl).toBeTruthy();
    expect(secretUrl.closest('.ph-no-capture')).not.toBeNull();
    expect(secretUrl.getAttribute('data-ph-mask')).toBe('true');
    expect(screen.getByText("Save this URL now. It will not be shown again.")).toBeTruthy();
    expect(api.createAccessLink).toHaveBeenCalledWith("launch",{baseRevision:1},expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button",{name:"Revoke link"}));
    await waitFor(()=>expect(api.revokeAccessLink).toHaveBeenCalledWith("launch",link.id,expect.any(AbortSignal)));
    expect(screen.queryByText(url)).toBeNull();
  });
  it("uses the collaboration invite hierarchy while keeping email disabled and reusing one-time links", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,accessMode:"private_link" as const};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    const api=client({get:vi.fn(async()=>privateSite),accessLinks:vi.fn(async()=>({links:[]})),createAccessLink:vi.fn(async()=>({link,url}))});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" ownerIdentity="owner@example.com" />);

    expect(await screen.findByRole("heading",{name:"Invite"})).toBeTruthy();
    expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",true);
    expect(screen.getByRole("button",{name:"Invite"})).toHaveProperty("disabled",true);
    expect(screen.getByText("You (owner@example.com)")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.queryByText(/upgrade to pro/i)).toBeNull();
    expect(screen.queryByRole("button",{name:"Create one-time link"})).toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.getByText("One-time invite link")).toBeTruthy();
    expect(screen.getByText("Unclaimed links expire after 7 days.")).toBeTruthy();
    expect(screen.queryByText("One-time access for one browser.")).toBeNull();

    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    const create=screen.getByRole("button",{name:"Create invite link"});
    fireEvent.click(create);
    expect(await screen.findByText(url)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Copy invite link"})).toBeTruthy();
    expect(api.createAccessLink).toHaveBeenCalledWith("launch",{baseRevision:1},expect.any(AbortSignal));

    const publishing=screen.getByRole("button",{name:/Publish app to a permanent URL/});
    expect(publishing.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(publishing);
    expect(publishing.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Title")).toHaveProperty("value","Launch");
    expect(screen.getByText("Host the whole app at a stable Matrix.page URL.")).toBeTruthy();
  });
  it("uses the existing Share email row for capable email publications and shows ordered results", async () => {
    const emailSite={...published,accessMode:"private_email" as const,capabilities:{privateEmailInvitations:true}};
    const invitation={id:"44444444-4444-4444-8444-444444444444",emailAddress:"first@example.com",state:"pending" as const,
      deliveryState:"queued" as const,generation:1,revision:0,issuedAt:"2026-11-13T00:00:00.000Z",
      expiresAt:"2026-11-20T00:00:00.000Z",updatedAt:"2026-11-13T00:00:00.000Z",acceptedAt:null,revokedAt:null};
    const createEmailInvitations=vi.fn(async()=>({siteRevision:2,results:[
      {inputIndex:0,outcome:"queued" as const,invitation},
      {inputIndex:1,outcome:"invalid" as const},
    ]}));
    const api=client({get:vi.fn(async()=>emailSite),createEmailInvitations,
      emailInvitations:vi.fn(async()=>({invitations:[invitation],nextCursor:null,siteRevision:2}))});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" ownerIdentity="owner@example.com" />);
    await waitFor(()=>expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",false));
    const input=screen.getByLabelText("Invite by email");
    fireEvent.change(input,{target:{value:"first@example.com, invalid-address"}});
    fireEvent.click(screen.getByRole("button",{name:"Invite"}));
    await waitFor(()=>expect(createEmailInvitations).toHaveBeenCalledWith("launch",
      {baseRevision:1,emailAddresses:["first@example.com","invalid-address"]},expect.any(AbortSignal)));
    expect(await screen.findByText("first@example.com — queued")).toBeTruthy();
    expect(screen.getByText("invalid-address — invalid address")).toBeTruthy();
    expect(screen.getAllByRole("heading",{name:"Invite"})).toHaveLength(1);
    expect(screen.getByText("One-time invite link")).toBeTruthy();
  });
  it("does not silently replace email access when an owner creates a one-time link", async () => {
    const emailSite={...published,accessMode:"private_email" as const,capabilities:{privateEmailInvitations:true}};
    const api=client({get:vi.fn(async()=>emailSite)});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);
    await waitFor(()=>expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",false));
    const create=await screen.findByRole("button",{name:"Create invite link"});
    expect(create).toHaveProperty("disabled",true);
    fireEvent.click(create);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.createAccessLink).not.toHaveBeenCalled();
  });
  it("keeps pasted email lines in the shared multiline control", async () => {
    const emailSite={...published,accessMode:"private_email" as const,capabilities:{privateEmailInvitations:true}};
    const createEmailInvitations=vi.fn(async()=>({siteRevision:2,results:[]}));
    const api=client({get:vi.fn(async()=>emailSite),createEmailInvitations});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);
    await waitFor(()=>expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",false));
    const input=screen.getByLabelText("Invite by email");
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.getAttribute("data-slot")).toBe("textarea");
    fireEvent.change(input,{target:{value:"alice@example.com\nbob@example.com"}});
    fireEvent.click(screen.getByRole("button",{name:"Invite"}));
    await waitFor(()=>expect(createEmailInvitations).toHaveBeenCalledWith("launch",
      {baseRevision:1,emailAddresses:["alice@example.com","bob@example.com"]},expect.any(AbortSignal)));
  });
  it("offers email as a separate access mode only when the capability is ready", async () => {
    const publicSite={...published,capabilities:{privateEmailInvitations:true}};
    const emailSite={...publicSite,accessMode:"private_email" as const,revision:2};
    const api=client({get:vi.fn(async()=>publicSite),update:vi.fn(async()=>emailSite)});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);
    await screen.findByText("Your app is public.");
    expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",true);
    fireEvent.click(screen.getByRole("button",{name:/Publish app to a permanent URL/}));
    fireEvent.change(screen.getByLabelText("Access"),{target:{value:"private_email"}});
    fireEvent.click(screen.getByRole("button",{name:"Save URL and details"}));
    await waitFor(()=>expect(api.update).toHaveBeenCalledWith("launch",
      expect.objectContaining({accessMode:"private_email",baseRevision:1}),expect.any(AbortSignal)));
    await waitFor(()=>expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",false));
    expect(screen.getByText("Your app uses email invitations.")).toBeTruthy();
  });
  it("keeps an unsent address visible after a conflict and asks for an authoritative refresh", async () => {
    const emailSite={...published,accessMode:"private_email" as const,capabilities:{privateEmailInvitations:true}};
    const api=client({get:vi.fn(async()=>emailSite),createEmailInvitations:vi.fn(async()=>{throw new SiteClientError(409);})});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);
    await waitFor(()=>expect(screen.getByLabelText("Invite by email")).toHaveProperty("disabled",false));
    fireEvent.change(screen.getByLabelText("Invite by email"),{target:{value:"viewer@example.com"}});
    fireEvent.click(screen.getByRole("button",{name:"Invite"}));
    expect((await screen.findByRole("alert")).textContent).toContain("Refresh and try again");
    expect(screen.getByLabelText("Invite by email")).toHaveProperty("value","viewer@example.com");
    expect(screen.getByRole("button",{name:"Refresh publication"})).toBeTruthy();
  });
  it("pages email inventory and resends an expired invitation with its revisions", async () => {
    const emailSite={...published,accessMode:"private_email" as const,capabilities:{privateEmailInvitations:true}};
    const expired={id:"44444444-4444-4444-8444-444444444444",emailAddress:"older@example.com",state:"expired" as const,
      deliveryState:"failed" as const,generation:1,revision:3,issuedAt:"2026-11-01T00:00:00.000Z",
      expiresAt:"2026-11-08T00:00:00.000Z",updatedAt:"2026-11-08T00:00:00.000Z",acceptedAt:null,revokedAt:null};
    const emailInvitations=vi.fn().mockResolvedValueOnce({invitations:[],nextCursor:"page-two",siteRevision:1})
      .mockResolvedValue({invitations:[expired],nextCursor:null,siteRevision:1});
    const resendEmailInvitation=vi.fn(async()=>({invitation:{...expired,state:"pending" as const,deliveryState:"queued" as const,
      generation:2,revision:4},siteRevision:2}));
    const api=client({get:vi.fn(async()=>emailSite),emailInvitations,resendEmailInvitation});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);
    fireEvent.click(await screen.findByRole("button",{name:"Load more invitations"}));
    expect(await screen.findByText(/older@example.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Resend"}));
    await waitFor(()=>expect(resendEmailInvitation).toHaveBeenCalledWith("launch",expired.id,
      {baseRevision:1,invitationRevision:3},expect.any(AbortSignal)));
    expect(screen.getByText(/older@example.com/)).toBeTruthy();
  });
  it("creates an invite in one click by privately publishing a new app", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,title:"launch",description:"",slug:null,accessMode:"private_link" as const};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    const api=client({
      get:vi.fn(async()=>null),
      deploy:vi.fn(async()=>privateSite),
      createAccessLink:vi.fn(async()=>({link,url})),
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" ownerIdentity="user_owner" />);

    await screen.findByRole("button",{name:"Create invite link"});
    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    expect(screen.queryByText(/publish.*private.*create/i)).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));

    expect(await screen.findByText(url)).toBeTruthy();
    expect(api.getConfig).toHaveBeenCalledWith("launch",expect.any(AbortSignal));
    expect(api.deploy).toHaveBeenCalledWith("launch",expect.objectContaining({
      title:"launch",description:"",slug:null,accessMode:"private_link",baseRevision:0,
      reviewedConfig:{data:{},forms:[]},
    }),expect.any(AbortSignal));
    expect(api.createAccessLink).toHaveBeenCalledWith("launch",{baseRevision:1},expect.any(AbortSignal));
  });
  it("keeps confirmed private publication state when invite creation fails", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,title:"launch",description:"",slug:null,accessMode:"private_link" as const};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    const createAccessLink=vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({link,url});
    const api=client({
      get:vi.fn(async()=>null),
      deploy:vi.fn(async()=>privateSite),
      createAccessLink,
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);

    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));

    expect(await screen.findByText("Your app uses one-time links.")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe("Could not complete this action. Please try again.");
    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));

    expect(await screen.findByText(url)).toBeTruthy();
    expect(api.deploy).toHaveBeenCalledTimes(1);
    expect(createAccessLink).toHaveBeenNthCalledWith(1,"launch",{baseRevision:1},expect.any(AbortSignal));
    expect(createAccessLink).toHaveBeenNthCalledWith(2,"launch",{baseRevision:1},expect.any(AbortSignal));
  });
  it("keeps a created invite when an older empty link list returns later", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,title:"launch",description:"",slug:null,accessMode:"private_link" as const};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    let resolveCreate!: (value:{link:typeof link;url:string})=>void;
    let resolveList!: (value:{links:typeof link[]})=>void;
    const createPending=new Promise<{link:typeof link;url:string}>(resolve=>{resolveCreate=resolve;});
    const listPending=new Promise<{links:typeof link[]}>(resolve=>{resolveList=resolve;});
    const accessLinks=vi.fn()
      .mockImplementationOnce(()=>listPending)
      .mockResolvedValue({links:[link]});
    const api=client({
      get:vi.fn(async()=>null),
      deploy:vi.fn(async()=>privateSite),
      accessLinks,
      createAccessLink:vi.fn(()=>createPending),
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);

    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));
    await waitFor(()=>expect(api.accessLinks).toHaveBeenCalledTimes(1));
    await act(async()=>resolveCreate({link,url}));

    expect(await screen.findByText(url)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Revoke link"})).toBeTruthy();
    await act(async()=>resolveList({links:[]}));

    await waitFor(()=>expect(accessLinks).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button",{name:"Revoke link"})).toBeTruthy();
  });
  it("refreshes after revocation makes a link-list retry stale", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,title:"launch",description:"",slug:null,accessMode:"private_link" as const};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    let resolveCreate!: (value:{link:typeof link;url:string})=>void;
    let rejectInitialList!: (reason:Error)=>void;
    let resolveRetry!: (value:{links:typeof link[]})=>void;
    const createPending=new Promise<{link:typeof link;url:string}>(resolve=>{resolveCreate=resolve;});
    const initialList=new Promise<{links:typeof link[]}>((_resolve,reject)=>{rejectInitialList=reject;});
    const retryPending=new Promise<{links:typeof link[]}>(resolve=>{resolveRetry=resolve;});
    const accessLinks=vi.fn()
      .mockImplementationOnce(()=>initialList)
      .mockImplementationOnce(()=>retryPending)
      .mockResolvedValue({links:[]});
    const api=client({
      get:vi.fn(async()=>null),
      deploy:vi.fn(async()=>privateSite),
      accessLinks,
      createAccessLink:vi.fn(()=>createPending),
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);

    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));
    await waitFor(()=>expect(accessLinks).toHaveBeenCalledTimes(1));
    await act(async()=>rejectInitialList(new Error("network unavailable")));
    expect(await screen.findByRole("button",{name:"Retry link list"})).toBeTruthy();
    await act(async()=>resolveCreate({link,url}));
    expect(await screen.findByRole("button",{name:"Revoke link"})).toBeTruthy();

    fireEvent.click(screen.getByRole("button",{name:"Retry link list"}));
    await waitFor(()=>expect(accessLinks).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button",{name:"Revoke link"}));
    await waitFor(()=>expect(api.revokeAccessLink).toHaveBeenCalledWith("launch",link.id,expect.any(AbortSignal)));
    await act(async()=>resolveRetry({links:[link]}));

    await waitFor(()=>expect(accessLinks).toHaveBeenCalledTimes(3));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    expect(screen.queryByRole("button",{name:"Revoke link"})).toBeNull();
  });
  it("creates an invite in one click for an existing public app", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,accessMode:"private_link" as const,revision:2};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    const api=client({
      update:vi.fn(async()=>privateSite),
      createAccessLink:vi.fn(async()=>({link,url})),
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);

    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));

    expect(await screen.findByText(url)).toBeTruthy();
    expect(api.update).toHaveBeenCalledWith("launch",{
      title:"Launch",description:"Join us",slug:"matrix-launch",accessMode:"private_link",baseRevision:1,
    },expect.any(AbortSignal));
    expect(api.createAccessLink).toHaveBeenCalledWith("launch",{baseRevision:2},expect.any(AbortSignal));
  });
  it("keeps invite conflicts and recovery visible while permanent publishing stays closed", async () => {
    const privateSite={...published,accessMode:"private_link" as const};
    const api=client({
      get:vi.fn(async()=>privateSite),
      accessLinks:vi.fn(async()=>({links:[]})),
      createAccessLink:vi.fn(async()=>{throw new SiteClientError(409);}),
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);

    const publishing=screen.getByRole("button",{name:/Publish app to a permanent URL/});
    expect(publishing.getAttribute("aria-expanded")).toBe("false");
    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    fireEvent.click(screen.getByRole("button",{name:"Create invite link"}));

    expect((await screen.findByRole("alert")).textContent).toContain("publication changed");
    expect(screen.getByRole("button",{name:"Refresh publication"})).toBeTruthy();
    expect(publishing.getAttribute("aria-expanded")).toBe("false");
  });
  it("keeps initial load recovery visible while permanent publishing stays closed", async () => {
    const api=client({get:vi.fn(async()=>{throw new Error("private internal host");})});
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);

    const publishing=screen.getByRole("button",{name:/Publish app to a permanent URL/});
    expect(publishing.getAttribute("aria-expanded")).toBe("false");
    expect((await screen.findByRole("alert")).textContent).toBe("Publishing is unavailable. Please try again.");
    expect(screen.getByRole("button",{name:"Retry"})).toBeTruthy();
    expect(publishing.getAttribute("aria-expanded")).toBe("false");
  });
  it("removes a generated invite after refresh confirms the publication no longer supports links", async () => {
    const link={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const privateSite={...published,accessMode:"private_link" as const};
    const unpublishedSite={...privateSite,status:"unpublished" as const,revision:2};
    const url=`https://matrix.page/${privateSite.id}#access=${link.id}.${"a".repeat(43)}`;
    const api=client({
      get:vi.fn().mockResolvedValueOnce(privateSite).mockResolvedValueOnce(unpublishedSite),
      accessLinks:vi.fn(async()=>({links:[]})),
      createAccessLink:vi.fn(async()=>({link,url})),
      update:vi.fn(async()=>{throw new SiteClientError(409);}),
    });
    render(<AppSitePanel appSlug="launch" client={api} variant="share" />);
    await waitFor(()=>expect(screen.getByRole("button",{name:"Create invite link"})).toHaveProperty("disabled",false));
    const create=screen.getByRole("button",{name:"Create invite link"});
    fireEvent.click(create);
    expect(await screen.findByText(url)).toBeTruthy();

    fireEvent.click(screen.getByRole("button",{name:/Publish app to a permanent URL/}));
    fireEvent.change(screen.getByLabelText("Access"),{target:{value:"public"}});
    fireEvent.click(screen.getByRole("button",{name:"Save URL and details"}));
    fireEvent.click(await screen.findByRole("button",{name:"Refresh publication"}));

    await screen.findByText("This app is private.");
    expect(screen.queryByText(url)).toBeNull();
    expect(screen.queryByRole("button",{name:"Copy invite link"})).toBeNull();
  });
  it("offers publication refresh when one-time link creation loses a revision race",async()=>{
    const privateSite={...published,accessMode:"private_link" as const};
    const api=client({get:vi.fn(async()=>privateSite),accessLinks:vi.fn(async()=>({links:[],nextCursor:null})),createAccessLink:vi.fn(async()=>{throw new SiteClientError(409);})});
    render(<AppSitePanel appSlug="launch" client={api} />);
    const create=await screen.findByRole("button",{name:"Create one-time link"});
    await waitFor(()=>expect(create).toHaveProperty("disabled",false));
    fireEvent.click(create);
    expect(await screen.findByRole("button",{name:"Refresh publication"})).toBeTruthy();
  });
  it("loads every one-time link through bounded owner pages",async()=>{
    const privateSite={...published,accessMode:"private_link" as const};
    const first={id:"44444444-4444-4444-8444-444444444444",status:"unclaimed" as const,createdAt:"2026-11-05T12:00:00.000Z",claimExpiresAt:"2026-11-12T12:00:00.000Z",claimedAt:null,sessionExpiresAt:null};
    const second={...first,id:"55555555-5555-4555-8555-555555555555",status:"claimed" as const,claimedAt:"2026-11-06T12:00:00.000Z",sessionExpiresAt:"2026-12-06T12:00:00.000Z"};
    const cursor=`${first.createdAt}|${first.id}`;
    const accessLinks=vi.fn().mockResolvedValueOnce({links:[first],nextCursor:cursor}).mockResolvedValueOnce({links:[second],nextCursor:null});
    render(<AppSitePanel appSlug="launch" client={client({get:vi.fn(async()=>privateSite),accessLinks})} />);
    fireEvent.click(await screen.findByRole("button",{name:"Load more links"}));
    await screen.findByText(/Access expires/);
    expect(accessLinks).toHaveBeenNthCalledWith(1,"launch",expect.any(AbortSignal));
    expect(accessLinks).toHaveBeenNthCalledWith(2,"launch",expect.any(AbortSignal),cursor);
    expect(screen.queryByRole("button",{name:"Load more links"})).toBeNull();
  });
  it("fails closed and retries when private link metadata cannot be loaded",async()=>{
    const privateSite={...published,accessMode:"private_link" as const};
    const accessLinks=vi.fn().mockRejectedValueOnce(new Error("postgres://private/password")).mockResolvedValueOnce({links:[],nextCursor:null});
    render(<AppSitePanel appSlug="launch" client={client({get:vi.fn(async()=>privateSite),accessLinks})} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not complete this action. Please try again.");
    expect(screen.getByRole("button",{name:"Create one-time link"})).toHaveProperty("disabled",true);
    fireEvent.click(screen.getByRole("button",{name:"Retry link list"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Create one-time link"})).toHaveProperty("disabled",false));
    expect(accessLinks).toHaveBeenCalledTimes(2);
  });
  it("toggles deployment review closed and fetches a fresh unapproved declaration on reopening", async () => {
    const getConfig=vi.fn().mockResolvedValueOnce({data:{revision:"first"},forms:[]}).mockResolvedValueOnce({data:{revision:"second"},forms:[]});
    const api=client({getConfig});
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    const trigger=screen.getByRole("button",{name:"Review deployment"});
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByLabelText("I reviewed this deployment"));
    expect(screen.getByRole("button",{name:"Publish update"})).toHaveProperty("disabled",false);
    fireEvent.click(trigger);
    expect(screen.queryByLabelText("Deployment preview")).toBeNull();
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button",{name:"Publish update"})).toHaveProperty("disabled",true);
    fireEvent.click(trigger);
    await screen.findByText(/"second"/);
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("I reviewed this deployment")).toHaveProperty("checked",false);
    expect(screen.getByRole("button",{name:"Publish update"})).toHaveProperty("disabled",true);
  });
  it("toggles visitor submissions closed and reloads only when reopened", async () => {
    const api = client();
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    const trigger = screen.getByRole("button", { name: "Visitor submissions" });
    fireEvent.click(trigger);
    const region = await screen.findByRole("region", { name: "Visitor submissions" });
    await screen.findByText("No visitor submissions yet.");
    expect(api.submissions).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger);
    expect(screen.queryByRole("region", { name: "Visitor submissions" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(api.submissions).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger);
    const reopened = await screen.findByRole("region", { name: "Visitor submissions" });
    await waitFor(() => expect(api.submissions).toHaveBeenCalledTimes(2));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(reopened.id).toBe(trigger.getAttribute("aria-controls"));
    expect(region.id).toBe(reopened.id);
  });
  it("guides owners through an empty visitor submissions state", async () => {
    render(<AppSitePanel appSlug="launch" client={client()} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    const empty = await screen.findByRole("status", { name: "No visitor submissions yet" });
    expect(within(empty).getByRole("heading", { name: "No visitor submissions yet." })).toBeTruthy();
    expect(empty.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(within(empty).getByText("Responses from your published forms will appear here.")).toBeTruthy();
    expect(within(empty).getByText("Share the public app link and ask visitors to submit a form.")).toBeTruthy();
  });
  it("loads publication and requires preview before deploying draft changes", async () => {
    const api = client({ get: vi.fn(async () => null) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    expect(screen.getByText("Loading publication…")).toBeTruthy();
    await screen.findByText("This app is private.");
    const deploy = screen.getByRole("button", { name: "Publish app" });
    expect(deploy).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(await screen.findByText(/Only declared public data and forms/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    fireEvent.click(deploy);
    await screen.findByText("Published successfully.");
    expect(api.deploy).toHaveBeenCalledWith("launch", expect.objectContaining({ title: "launch", reviewedConfig: { data: {}, forms: [] } }), expect.any(AbortSignal));
  });
  it("preserves live state and hides server details on failed unpublish", async () => {
    const api = client({ unpublish: vi.fn(async () => { throw new Error("postgres://secret.internal/password"); }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not complete this action. Please try again.");
    expect(screen.getByText("Your app is public.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm unpublish" })).toBeTruthy();
  });
  it("provides version rollback and retained visitor submissions with export and delete", async () => {
    const api = client({ submissions: vi.fn().mockResolvedValueOnce({ submissions: [{ id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" }], nextCursor: null }).mockResolvedValue({ submissions: [], nextCursor: null }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: /Restore version/ }));
    await screen.findByText("Version restored.");
    expect(api.rollback).toHaveBeenCalledWith("launch", { versionId: published.versions[1].id, baseRevision: 1 }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText(/Ada/);
    expect(screen.getByRole("button", { name: "Export this page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete submission" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByText("No visitor submissions yet.");
    expect(api.deleteSubmission).toHaveBeenCalledWith("launch", "44444444-4444-4444-8444-444444444444", expect.any(AbortSignal));
  });
  it("ignores late requests when the selected app changes", async () => {
    let finish!: (value: typeof published) => void;
    const api = client({ get: vi.fn((app) => app === "launch" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null)) });
    const { rerender } = render(<AppSitePanel appSlug="launch" client={api} />);
    rerender(<AppSitePanel appSlug="other" client={api} />);
    await screen.findByText("This app is private.");
    await act(async () => finish(published));
    expect(screen.queryByText("Your app is public.")).toBeNull();
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "other");
  });
  it("handles load failures with a retry without claiming that the app is private", async () => {
    const api = client({ get: vi.fn(async () => { throw new Error("private internal host"); }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Publishing is unavailable. Please try again.");
    expect(screen.queryByText("This app is private.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("clears the previous runtime publication before a replacement client resolves for the same app", async () => {
    let finish!: (value: typeof published) => void;
    const original = client();
    const replacement = client({ get: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    const { rerender } = render(<AppSitePanel appSlug="launch" client={original} />);
    await screen.findByText("Your app is public.");
    rerender(<AppSitePanel appSlug="launch" client={replacement} />);
    expect(screen.getByText("Loading publication…")).toBeTruthy();
    expect(screen.queryByText("Your app is public.")).toBeNull();
    expect(screen.queryByText(published.url)).toBeNull();
    await act(async () => finish({ ...published, title: "Replacement runtime", description: "Fresh details" }));
    await screen.findByText("Your app is public.");
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Replacement runtime");
  });
  it("keeps a submission visible after delete failure and catches export failures", async () => {
    const api = client({
      submissions: vi.fn(async () => ({ submissions: [{ id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" }], nextCursor: "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444" })),
      deleteSubmission: vi.fn(async () => { throw new Error("private database down"); }),
      exportSubmissions: vi.fn(async () => { throw new Error("filesystem /private/path"); }),
    });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Delete submission" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export this page" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain("private");
    expect(api.exportSubmissions).toHaveBeenCalledWith("launch", null, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
  });
  it("invalidates review when metadata changes and fails closed on config failure", async () => {
    const api = client({ get: vi.fn(async () => null), getConfig: vi.fn(async () => ({ data: { event: "Launch" }, forms: [] })) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("This app is private.");
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByText(/Only declared public data/);
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    expect(screen.getByRole("button", { name: "Publish app" })).toHaveProperty("disabled", false);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New launch" } });
    expect(screen.getByRole("button", { name: "Publish app" })).toHaveProperty("disabled", true);
    vi.mocked(api.getConfig).mockRejectedValueOnce(new Error("internal manifest path"));
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Publish app" })).toHaveProperty("disabled", true);
  });

  it("initializes metadata from an asynchronously loaded publication", async () => {
    let resolve!: (site: typeof published) => void;
    const api = client({ get: vi.fn(() => new Promise(done => { resolve = done; })) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "launch");
    await act(async () => resolve({ ...published, title: "Launch guidance", description: "Start here", slug: "getting-started" }));
    await screen.findByText("Your app is public.");
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Launch guidance");
    expect(screen.getByLabelText("Description")).toHaveProperty("value", "Start here");
    expect(screen.getByLabelText("Friendly path (optional)")).toHaveProperty("value", "getting-started");
  });
  it("requires a new deployment review after a version is restored", async () => {
    const restored = { ...published, revision: 2, activeVersion: published.versions[1].id, title: "Restored launch" };
    const api = client({ rollback: vi.fn(async () => restored) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByText(/Only declared public data/);
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: /Restore version/ }));
    await screen.findByText("Version restored.");
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Restored launch");
    expect(screen.queryByLabelText("I reviewed this deployment")).toBeNull();
    expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", true);
  });
  it("reloads the current submission page after deletion to refill its visible records", async () => {
    const row = { id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" };
    const api = client({ submissions: vi.fn().mockResolvedValueOnce({ submissions: [row], nextCursor: "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444" }).mockResolvedValueOnce({ submissions: [{ ...row, id: "55555555-5555-4555-8555-555555555555", fields: { name: "Previously next page" } }], nextCursor: null }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public."); fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText("Ada"); fireEvent.click(screen.getByRole("button", { name: "Delete submission" })); fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByText("Previously next page");
    expect(api.submissions).toHaveBeenNthCalledWith(2, "launch", null, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("invalidates the visible page and removes a confirmed deletion if the page reload fails", async () => {
    const row = { id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" };
    const api = client({ submissions: vi.fn().mockResolvedValueOnce({ submissions: [row], nextCursor: "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444" }).mockRejectedValueOnce(new Error("private database path")) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public."); fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText("Ada"); fireEvent.click(screen.getByRole("button", { name: "Delete submission" })); fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Ada")).toBeNull(); expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(screen.queryByText("private database path")).toBeNull();
    expect(screen.getByRole("button", { name: "Export this page" })).toHaveProperty("disabled", true);
  });

});
