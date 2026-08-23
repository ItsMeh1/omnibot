const API='https://discord.com/api/v10';
const INTENTS=1|512|32768;

export default {
  async fetch(request,env){
    const url=new URL(request.url), cors=corsHeaders(request,env);
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    if(url.pathname==='/api/config') return json({clientId:env.DISCORD_CLIENT_ID||'',inviteUrl:env.DISCORD_CLIENT_ID?`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(env.DISCORD_CLIENT_ID)}&scope=bot%20applications.commands`:''},200,cors);
    if(url.pathname==='/api/health') return withCors(await bridge(env).fetch(new Request('https://do/internal/health')),cors);
    if(url.pathname==='/api/guilds'){
      const r=await discord(env,'/users/@me/guilds?limit=200'); if(!r.ok)return discordError(r,cors);
      return json((await r.json()).map(g=>({id:g.id,name:g.name,icon:g.icon?`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`:null})),200,cors);
    }
    const gc=url.pathname.match(/^\/api\/guilds\/([^/]+)\/channels$/);
    if(gc){const r=await discord(env,`/guilds/${gc[1]}/channels`);if(!r.ok)return discordError(r,cors);return json((await r.json()).filter(c=>c.type===0).sort((a,b)=>(a.position||0)-(b.position||0)).map(c=>({id:c.id,name:c.name,position:c.position,categoryId:c.parent_id})),200,cors);}
    const cm=url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
    if(cm&&request.method==='GET'){const r=await discord(env,`/channels/${cm[1]}/messages?limit=100`);if(!r.ok)return discordError(r,cors);return json((await r.json()).reverse().map(pack),200,cors);}
    if(cm&&request.method==='POST'){
      if(env.WRITE_API_KEY&&request.headers.get('x-omnibot-key')!==env.WRITE_API_KEY)return json({error:'Unauthorized'},401,cors);
      const body=await request.json().catch(()=>({})),content=String(body.content||'').trim();
      if(!content||content.length>2000)return json({error:'Message must be 1-2000 characters.'},400,cors);
      const r=await discord(env,`/channels/${cm[1]}/messages`,{method:'POST',body:JSON.stringify({content,allowed_mentions:{parse:[]}})});if(!r.ok)return discordError(r,cors);return json(pack(await r.json()),201,cors);
    }
    if(url.pathname==='/ws')return bridge(env).fetch(request);
    return new Response('OmniBot Worker online',{headers:{...cors,'content-type':'text/plain'}});
  }
};

const bridge=env=>env.BOT_BRIDGE.get(env.BOT_BRIDGE.idFromName('global'));
const discord=(env,path,opt={})=>fetch(API+path,{...opt,headers:{authorization:`Bot ${env.DISCORD_TOKEN}`,'content-type':'application/json',...(opt.headers||{})}});
const user=u=>({id:u?.id,username:u?.username,globalName:u?.global_name||u?.username,avatar:u?.avatar?`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`:null,bot:!!u?.bot});
const pack=m=>({id:m.id,channelId:m.channel_id,guildId:m.guild_id||null,content:m.content||'',createdAt:Date.parse(m.timestamp),editedAt:m.edited_timestamp?Date.parse(m.edited_timestamp):null,author:user(m.author),attachments:(m.attachments||[]).map(a=>({id:a.id,name:a.filename,url:a.url,contentType:a.content_type||null,size:a.size,width:a.width,height:a.height}))});
const json=(v,s=200,h={})=>new Response(JSON.stringify(v),{status:s,headers:{'content-type':'application/json; charset=utf-8',...h}});
async function discordError(r,h){const t=await r.text();let e=t;try{e=JSON.parse(t).message||t}catch{}return json({error:e||`Discord ${r.status}`},r.status,h)}
function corsHeaders(req,env){const origin=req.headers.get('Origin')||'';const allowed=env.ALLOWED_ORIGIN||'*';return{'access-control-allow-origin':allowed==='*'?'*':origin===allowed?origin:allowed,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Content-Type,x-omnibot-key','cache-control':'no-store'}}
function withCors(r,h){const headers=new Headers(r.headers);for(const[k,v]of Object.entries(h))headers.set(k,v);return new Response(r.body,{status:r.status,headers})}

export class BotBridge{
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.gateway=null;this.clients=new Map();this.seq=null;this.heartbeat=null;this.reconnect=null;this.starting=false;}
  async fetch(req){const u=new URL(req.url);if(u.pathname==='/internal/health')return json({ok:true,gatewayConnected:!!this.gateway,browserClients:this.clients.size});if(req.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.accept();const id=crypto.randomUUID();this.clients.set(id,{socket:server,channelId:''});server.addEventListener('message',e=>this.browser(id,e.data));server.addEventListener('close',()=>this.clients.delete(id));server.addEventListener('error',()=>this.clients.delete(id));safe(server,{type:'status',gatewayConnected:!!this.gateway});this.start();return new Response(null,{status:101,webSocket:client});}
  browser(id,raw){try{const m=JSON.parse(raw),c=this.clients.get(id);if(c&&m.type==='subscribe'){c.channelId=String(m.channelId||'');safe(c.socket,{type:'subscribed',channelId:c.channelId});}}catch{}}
  async start(){if(this.gateway||this.starting||!this.env.DISCORD_TOKEN)return;this.starting=true;try{const r=await discord(this.env,'/gateway/bot');if(!r.ok)throw Error('Gateway discovery failed');const {url}=await r.json();const ws=await fetch(`${url}?v=10&encoding=json`,{headers:{Upgrade:'websocket'}});if(!ws.webSocket)throw Error('Gateway rejected WebSocket');this.gateway=ws.webSocket;this.gateway.accept();this.gateway.addEventListener('message',e=>this.gatewayMessage(e.data));this.gateway.addEventListener('close',()=>this.dead());this.gateway.addEventListener('error',()=>{});}catch(e){console.error('[OmniBot]',e.message);this.schedule();}finally{this.starting=false;}}
  gatewayMessage(raw){let p;try{p=JSON.parse(raw)}catch{return}if(p.s!==null&&p.s!==undefined)this.seq=p.s;if(p.op===10){this.beat(p.d.heartbeat_interval);this.send(2,{token:this.env.DISCORD_TOKEN,intents:INTENTS,properties:{os:'linux',browser:'omnibot',device:'omnibot'}});return}if(p.op===0)return this.dispatch(p.t,p.d);if(p.op===1)return this.send(1,this.seq);if(p.op===7||p.op===9)return this.reset();}
  beat(ms){if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=setInterval(()=>this.send(1,this.seq),Math.max(Number(ms)||41250,5000));}
  send(op,d){try{this.gateway?.send(JSON.stringify({op,d}))}catch{}}
  dead(){this.gateway=null;if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=null;this.broadcast({type:'status',gatewayConnected:false});this.schedule();}
  reset(){try{this.gateway?.close()}catch{}this.dead();}
  schedule(){if(this.reconnect)return;this.reconnect=setTimeout(()=>{this.reconnect=null;this.start()},5000);}
  dispatch(type,d){if(type==='READY'){this.broadcast({type:'status',gatewayConnected:true});return}if(type==='MESSAGE_CREATE')this.message('message:create',d);else if(type==='MESSAGE_UPDATE')this.message('message:update',d);else if(type==='MESSAGE_DELETE')this.message('message:delete',d);}
  message(type,d){const data=type==='message:delete'?{id:d.id,channelId:d.channel_id}:pack(d);for(const c of this.clients.values())if(c.channelId===d.channel_id)safe(c.socket,{type,data});}
  broadcast(v){for(const c of this.clients.values())safe(c.socket,v)}
}
const safe=(s,v)=>{try{s.send(JSON.stringify(v))}catch{}};
