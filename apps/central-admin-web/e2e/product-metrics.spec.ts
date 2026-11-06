import { test, expect, signIn, defaultMocks, gotoWithEntitlements, SUPER_USER, noHorizontalScroll } from "./fixtures";
const product={product_id:"karryam",display_name:"Karryam",available:true,effective_scope:{market:["NG-LAG"],organization:["karryam-staging"],zone:["NG-LAG-MAIN"],tenant:["karryam-staging-operations"]},datasets:[{dataset_id:"karryam.support_operations",granted:true}]};
const metric={metric_id:"karryam.support.cases_open",definition:"Open source-backed support cases"};
test("product metrics show source, freshness and real zero/missing distinctions",async({page,api})=>{
 await signIn(page,SUPER_USER);defaultMocks(api,SUPER_USER);
 api.on("GET","/api/products",{body:{products:[product]}});
 api.on("GET","/api/products/karryam/datasets",{body:{error:null,result:{datasets:[{dataset_id:"karryam.support_operations",metrics:[metric]}]}}});
 let observed=true;
 api.on("GET","/api/products/karryam/metrics/karryam.support.cases_open",()=>({body:{error:null,result:{observations:[{value:observed?2:null,value_state:observed?"OBSERVED":"UNAVAILABLE",source_observed_at:"2026-11-06T03:54:00Z",freshness:"FRESH",coverage:observed?"COMPLETE":"UNKNOWN"}]}}}));
 await gotoWithEntitlements(page,"/dashboard/help");
 const panel=page.getByRole("region",{name:"Product activity"});
 await expect(panel.locator("dd")).toHaveText("2");await expect(panel.getByText(/Source: Karryam Admin/)).toBeVisible();await expect(panel.getByText("Fresh ? Complete coverage")).toBeVisible();
 expect(await panel.locator("time").getAttribute("dateTime")).toBe("2026-11-06T03:54:00Z");
 await noHorizontalScroll(page);
 observed=false;await panel.getByRole("button",{name:"Refresh product activity"}).click();
 await expect(panel.locator("dd")).toHaveText("?");await expect(panel.getByText("Unavailable",{exact:true})).toBeVisible();
});
test("staff without product grants see no product panel",async({page,api})=>{
 await signIn(page,SUPER_USER);defaultMocks(api,SUPER_USER);api.on("GET","/api/products",{body:{products:[]}});
 await gotoWithEntitlements(page,"/dashboard/help");await expect.poll(()=>api.callsTo("GET","/api/products").length).toBeGreaterThan(0);
 await expect(page.getByRole("region",{name:"Product activity"})).toHaveCount(0);
});
