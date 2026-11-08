import { afterEach, expect, it, vi } from "vitest";
import { providerFetch, ProviderError } from "../src/providers/types";
afterEach(() => { vi.restoreAllMocks(); });
it("preserves streamed JSON responses and status headers", async () => {
 const encoder=new TextEncoder();
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode('{"ok":'));controller.enqueue(encoder.encode('true}'));controller.close();}}),{status:200,headers:{"Content-Type":"application/json","X-Fixture":"yes"}}));
 const result=await providerFetch("realdebrid","https://example.invalid/status",{});
 expect(result.status).toBe(200);expect(result.headers.get("X-Fixture")).toBe("yes");expect(await result.json()).toEqual({ok:true});
});
it("stops reading and cancels an oversized provider stream", async () => {
 let cancelled=false,pulls=0;
 const chunk=new Uint8Array(1024*1024);
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(chunk);},cancel(){cancelled=true;}})));
 await expect(providerFetch("realdebrid","https://example.invalid/status",{})).rejects.toMatchObject({provider:"realdebrid",statusCode:502,message:expect.stringContaining("exceeded")});
 expect(cancelled).toBe(true);expect(pulls).toBeLessThanOrEqual(11);
});
it("keeps the deadline active while the response body is stalled", async () => {
 vi.spyOn(globalThis,"fetch").mockImplementation(async (_url,init) => new Response(new ReadableStream({start(controller){init?.signal?.addEventListener("abort",()=>controller.error(new DOMException("Aborted","AbortError")),{once:true});}})));
 await expect(providerFetch("realdebrid","https://example.invalid/status",{},15)).rejects.toThrow(/timed out/);
});
it("retains valid empty 204 responses", async () => {
 vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(null,{status:204}));
 const response=await providerFetch("realdebrid","https://example.invalid/status",{});
 expect(response.status).toBe(204);expect(await response.text()).toBe("");expect(response.body).toBeNull();
});
