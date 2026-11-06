const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
// Isolate HTTP and database dependencies; security/encryption/state code remains real.
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
 if(request === 'axios') return {};
 if(request.endsWith('/shared/config/database')) return {prisma:{}};
 return originalLoad.call(this,request,parent,main);
};
let createProviderOAuth, providerReadiness, createKeyring, decryptJson;
try {
 ({createProviderOAuth,providerReadiness}=require('../src/modules/marketing/social-operations/services/provider-oauth.service'));
 ({createKeyring}=require('../src/modules/marketing/social-operations/security/encryption-keyring.service'));
 ({decryptJson}=require('../src/modules/marketing/social-operations/security/encryption.service'));
} finally { Module._load=originalLoad; }
function fixture(provider='X') {
 const callback=`https://admin.example/api/v1/marketing/social/oauth/${provider}/callback`;
 const env={SOCIAL_OAUTH_REDIRECT_URIS:callback,[`SOCIAL_${provider}_CLIENT_ID`]:'test-client',[`SOCIAL_${provider}_CLIENT_SECRET`]:'test-secret',[`SOCIAL_${provider}_REDIRECT_URI`]:callback};
 const keyring=createKeyring({keys:{v1:crypto.randomBytes(32)},activeVersion:'v1'});
 let row,saved,identities=[],calls=[],audits=[];
 const db={
  socialOAuthState:{create:async({data})=>{row={...data,usedAt:null};},findUnique:async()=>row,updateMany:async()=>{if(row.usedAt||row.expiresAt<=new Date())return {count:0};row.usedAt=new Date();return {count:1};}},
  adminUser:{findUnique:async()=>({id:'staff-1',status:'ACTIVE'})},
  socialAccountConnection:{findUnique:async()=>saved,upsert:async({create})=>(saved={id:'connection-1',...create}),update:async({data})=>(saved={...saved,...data})},
  socialPublishingIdentity:{upsert:async({create})=>identities.push(create)},
  auditLog:{create:async({data})=>audits.push(data)},
 };
 db.$transaction=async work=>work(db);
 const http={post:async(url,body,options)=>{calls.push({url,body,options});return {data:{access_token:'private-test-access',refresh_token:'private-test-refresh',expires_in:3600,scope:'users.read tweet.read'}};},get:async(url)=>{
  if(url.includes('/permissions'))return {data:{data:[{permission:'pages_show_list',status:'granted'}]}};
  if(url.includes('/accounts'))return {data:{data:[{id:'page-1',name:'Example page',instagram_business_account:{id:'ig-1',username:'example'}}]}};
  if(provider==='META')return {data:{id:'user-1',name:'Example'}};
  if(provider==='LINKEDIN')return {data:{sub:'user-1',name:'Example'}};
  if(provider==='TIKTOK')return {data:{data:{user:{open_id:'user-1',display_name:'Example'}}}};
  return {data:{data:{id:'user-1',username:'example'}}};
 }};
 const service=createProviderOAuth({db,http,env,keyring,allowList:[callback]});
 return {db,http,env,keyring,service,get row(){return row;},get saved(){return saved;},identities,calls,audits};
}
async function begin(f,provider='X'){return f.service.start({provider,adminUserId:'staff-1',browserBinding:'browser-1'});}
for(const provider of ['META','TIKTOK','X','LINKEDIN'])test(`${provider}: verified code exchange stores encrypted credentials and real identities`,async()=>{
 const f=fixture(provider),start=await begin(f,provider);
 const url=new URL(start.authorizationUrl);assert.equal(url.protocol,'https:');assert.ok(url.searchParams.get('state'));
 const result=await f.service.complete({provider,query:{state:start.state,code:'test-code'},browserBinding:'browser-1'});
 assert.equal(result.connected,true);assert.equal(f.saved.status,'ACTIVE');assert.equal(f.audits.length,1);assert.equal(f.identities.length,provider==='META'?2:1);
 const plaintext=decryptJson(f.saved.encryptedCredentials,{purpose:'SOCIAL_ACCOUNT_CONNECTION_CREDENTIALS',keyring:f.keyring});assert.equal(plaintext.accessToken,'private-test-access');
 assert.ok(!JSON.stringify(result).includes('private-test'));assert.ok(!f.saved.encryptedCredentials.toString().includes('private-test'));
 assert.equal(f.calls[0].options.maxRedirects,0);
 if(provider==='X'){assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(new URLSearchParams(f.calls[0].body).get('code_verifier'));}
 await assert.rejects(f.service.complete({provider,query:{state:start.state,code:'replay'},browserBinding:'browser-1'}),/state is invalid/);
});
test('wrong browser is rejected without consuming legitimate state',async()=>{const f=fixture(),s=await begin(f);await assert.rejects(f.service.complete({provider:'X',query:{state:s.state,code:'code'},browserBinding:'attacker'}),/Invalid social connection session/);assert.equal(f.row.usedAt,null);assert.equal(f.calls.length,0);});
test('expired state and declined consent never create accounts',async()=>{const f=fixture(),s=await begin(f);f.row.expiresAt=new Date(0);await assert.rejects(f.service.complete({provider:'X',query:{state:s.state,code:'code'},browserBinding:'browser-1'}),/state is invalid/);const g=fixture(),t=await begin(g);await assert.rejects(g.service.complete({provider:'X',query:{state:t.state,error:'access_denied'},browserBinding:'browser-1'}),/cancelled or declined/);assert.equal(g.saved,undefined);assert.equal(g.calls.length,0);});
test('provider failure is sanitized and never creates an account',async()=>{const f=fixture(),s=await begin(f);f.http.post=async()=>{throw new Error('private-test-access client_secret=test-secret');};await assert.rejects(f.service.complete({provider:'X',query:{state:s.state,code:'code'},browserBinding:'browser-1'}),e=>e.statusCode===502&&!e.message.includes('private-test'));assert.equal(f.saved,undefined);});
test('unconfigured or unsupported providers cannot start',async()=>{assert.ok(providerReadiness({}).every(p=>!p.available));const f=fixture();await assert.rejects(begin(f,'YOUTUBE'),/Unsupported/);delete f.env.SOCIAL_X_CLIENT_SECRET;await assert.rejects(begin(f),/not configured/);assert.equal(f.row,undefined);});
test('deactivated staff cannot complete authorization',async()=>{const f=fixture(),s=await begin(f);f.db.adminUser.findUnique=async()=>({id:'staff-1',status:'DISABLED'});await assert.rejects(f.service.complete({provider:'X',query:{state:s.state,code:'code'},browserBinding:'browser-1'}),/no longer active/);assert.equal(f.calls.length,0);});

test('Meta can reuse its existing app credentials without using advertising tokens', async () => {
 const f=fixture('META');
 f.env.META_APP_ID=f.env.SOCIAL_META_CLIENT_ID;
 f.env.META_APP_SECRET=f.env.SOCIAL_META_CLIENT_SECRET;
 delete f.env.SOCIAL_META_CLIENT_ID; delete f.env.SOCIAL_META_CLIENT_SECRET;
 f.env.META_ACCESS_TOKEN='advertising-token-not-for-login';
 f.env.META_AD_ACCOUNT_ID='advertising-account-not-for-login';
 const started=await begin(f,'META');
 assert.equal(new URL(started.authorizationUrl).searchParams.get('client_id'),'test-client');
 assert.ok(!started.authorizationUrl.includes('advertising-'));
 assert.equal(providerReadiness(f.env).find(p=>p.provider==='META').available,true);
});

test('reconnect rejects a different provider account before updating credentials', async () => {
 const f=fixture();
 f.db.socialAccountConnection.findUnique=async()=>({id:'existing-1',provider:'X',providerConnectionId:'different-account'});
 const start=await f.service.start({provider:'X',adminUserId:'staff-1',browserBinding:'browser-1',connectionId:'existing-1'});
 await assert.rejects(f.service.complete({provider:'X',query:{state:start.state,code:'code'},browserBinding:'browser-1'}),/same social account/);
 assert.equal(f.saved,undefined);assert.equal(f.audits.length,0);
});
