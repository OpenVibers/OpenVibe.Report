'use strict';
const assert = require('assert');
const { createAiCatalogue } = require('../server/data/ai-catalogue');
const { mergeMarket } = require('../server/data/ai-market');
const { boot, check, done, stubFetch, jsonResponse } = require('./helpers/boot');
const market = { generated_at: '2026-11-09T00:00:00Z', offers: [
    { model:'openai/gpt-5-nano', provider:'openai', provider_name:'OpenAI', provider_model:'gpt-5-nano', name:'GPT nano', kind:'chat', maker:'openai', routed:true, price:{in:0.1,out:0.5}, price_source:'https://openai.com/api/pricing/', price_checked_at:'2026-11-09' },
    { model:'openai/gpt-5-nano', provider:'cheap', provider_name:'Cheaper fixture', provider_model:'gpt-5-nano', name:'GPT nano', kind:'chat', maker:'openai', routed:false, price:{in:0.01,out:0.2}, price_source:'https://example.test/prices' },
    { model:'qwen/unrated', provider:'qwen', provider_model:'unrated', name:'Unrated', kind:'chat', maker:'qwen', routed:false, price:{in:null,out:null} },
] };
const catalogue = { models:[{ slug:'openai/gpt-5-nano', offers:[{provider:'openai',model:'gpt-5-nano',speed:{p50_ms:1234},requests_7d:42,uptime:0.99,error_rate:0.01}] }] };
(async()=>{
    await check('market client follows pages, shares cache and keeps a complete stale result',async()=>{
        let now=1000,calls=0,fail=false;
        const client=createAiCatalogue({now:()=>now,log:{warn(){}},fetchImpl:async url=>{
            calls++; if(fail)return jsonResponse({},503);
            return jsonResponse({...market,offers:url.includes('cursor=2')?market.offers.slice(2):market.offers.slice(0,2),next_cursor:url.includes('cursor=2')?null:'2'});
        }});
        const [a,b]=await Promise.all([client.market(),client.market()]); assert.strictEqual(calls,2);assert.strictEqual(a.offers.length,3);assert.deepStrictEqual(a,b);
        await client.market();assert.strictEqual(calls,2);now+=120001;fail=true;
        const stale=await client.market();assert(stale.stale);assert.strictEqual(stale.offers.length,3);
    });
    await check('cheapest provider wins without copying routed measurements onto another offer',()=>{
        const result=mergeMarket(catalogue,market);assert.strictEqual(result.models.length,2);
        const model=result.models[0];assert(model.routed);assert.strictEqual(model.offers[0].provider,'cheap');assert.strictEqual(model.offers[0].speed,undefined);assert.strictEqual(model.offers[1].speed.p50_ms,1234);
    });
    await check('routed offers absent from the pricebook still mark their market model as routed',()=>{
        const result=mergeMarket(catalogue,{...market,offers:market.offers.filter(o=>o.provider!=='openai')});
        const model=result.models.find(m=>m.slug==='openai/gpt-5-nano');
        assert(model.routed);assert.strictEqual(model.offers[0].provider,'cheap');
        assert.strictEqual(model.offers.find(o=>o.provider==='openai').speed.p50_ms,1234);
    });
    await check('metadata aliases do not borrow measurements from a different routed endpoint',()=>{
        const result=mergeMarket(catalogue,{...market,offers:[{...market.offers[0],provider_model:'gpt-5-nano-latest',routed:false}]});
        const offers=result.models[0].offers;
        assert.strictEqual(offers.find(o=>o.model==='gpt-5-nano-latest').routed,false);
        assert.strictEqual(offers.find(o=>o.model==='gpt-5-nano-latest').speed,undefined);
        assert.strictEqual(offers.find(o=>o.model==='gpt-5-nano').routed,true);
    });
    const source=stubFetch();
    const t=await boot({env:{OV_AI_INTERNAL_URL:'http://127.0.0.1:5231',OV_BENCH_INTERNAL_URL:'http://127.0.0.1:5230'},fetchImpl:async(url,opts)=>{
        const u=new URL(String(url));
        if(u.pathname==='/api/v1/exchange/market')return jsonResponse({...market,next_cursor:null});
        if(u.pathname==='/api/v1/exchange/catalog')return jsonResponse(catalogue);
        if(u.pathname==='/api/v1/kinds')return jsonResponse({kinds:[{id:'chat.arena',name:'Chat'}]});
        if(u.pathname==='/api/v1/ratings/chat.arena')return jsonResponse({board:{rows:[{subject:'gpt-5-nano-2025-08-07',elo:1000,games:20}]}});
        return source(url,opts);
    }});
    try {
        await check('pages list every market model, cheapest price, route marks and measured-only routed rows',async()=>{
            const r=await t.get('/ai/leaderboard');assert.strictEqual(r.status,200);assert(r.text.includes('qwen/unrated'));assert(r.text.includes('$0.01'));assert(r.text.includes('Routed here'));assert(r.text.includes('Not routed here'));
            assert(r.text.indexOf('gpt-5-nano-2025-08-07')<r.text.indexOf('qwen/unrated'));
            const p=await t.get('/ai/providers');assert(p.text.includes('Cheaper fixture'));assert(/1\.2[0-9]*\s*s/.test(p.text));assert(p.text.includes('Not routed here'));
            const api=await t.get('/api/v1/ai/leaderboard');assert(api.json().rows.some(r=>r.id==='qwen/unrated'&&!r.routed));
        });
    } finally { await t.close(); }
    done();
})().catch(e=>{console.error(e);process.exitCode=1;});
