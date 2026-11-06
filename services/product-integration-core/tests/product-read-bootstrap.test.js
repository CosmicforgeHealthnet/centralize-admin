"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {validate,ACTIONS,run}=require("../scripts/bootstrap-product-read-grant");
const now=Date.now(),input={product:"karryam",staff:"41408630-e8fb-4710-ace8-8472b8392299",datasets:["karryam.support_operations","karryam.sync_health"],scope:{market:["NG-LAG"],organization:["karryam-staging"],zone:["NG-LAG-MAIN"],tenant:["karryam-staging-operations"]},expires:new Date(now+3600000).toISOString()};
test("first product bootstrap contains only scoped, expiring metric read permissions",()=>{
 const grant=validate(input,now);assert.deepEqual(grant.actions,ACTIONS);assert.equal(grant.grant_kind,"PRODUCT");assert.equal(grant.role,"karryam.operations.viewer");assert.ok(!grant.actions.includes("resource.read"));assert.ok(!grant.actions.includes("operation.submit"));
 for(const changes of [{datasets:[]},{datasets:["other.support"]},{datasets:["karryam.a","karryam.a"]},{scope:{market:["*"]}},{scope:{...input.scope,tenant:["a","b"]}},{expires:new Date(now-1).toISOString()},{expires:new Date(now+73*3600000).toISOString()}])assert.throws(()=>validate({...input,...changes},now));
});
test("product read bootstrap refuses execution outside root staging",async()=>{
 await assert.rejects(run([],{}),/ROOT_STAGING_ONLY/);
});
