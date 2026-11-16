(function () {
var __opalnote_plugin=(()=>{var i=Object.defineProperty;var _=Object.getOwnPropertyDescriptor;var c=Object.getOwnPropertyNames;var h=Object.prototype.hasOwnProperty;var g=(n,e)=>{for(var a in e)i(n,a,{get:e[a],enumerable:!0})},b=(n,e,a,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of c(e))!h.call(n,o)&&o!==a&&i(n,o,{get:()=>e[o],enumerable:!(t=_(e,o))||t.enumerable});return n};var k=n=>b(i({},"__esModule",{value:!0}),n);var m={};g(m,{default:()=>s});function s(){let n=function(t){return String(t).replace(/!\[([^\]]*)\]\([^)]+\)/g,"$1").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,"$2").replace(/\[\[([^\]]+)\]\]/g,"$1").replace(/[`*]/g,"").replace(/^[#>\-*+\s]+/,"").trim()},a=__query(`
  ?[note_path, line, text, status, updated_at, title] :=
      *task{notebook_id, note_path, line, text, status, updated_at},
      *note{notebook_id, path: note_path, title},
      notebook_id = $notebook_id,
      status != "done",
      status != "cancelled"
  :order -updated_at
  :limit 100
  `,{notebook_id:__notebook_id}).map(function(t){let[o,r,l,p,d,u]=t;return{id:String(o)+":"+String(r),title:n(l),detail:String(u),note_path:String(o),line:Number(r),status:String(p),updated_at:Number(d)}});return{items:a,ui:{schema:1,root:{type:"card",title:"Open todos",children:[{type:"list",emptyText:"All clear.",items:a.map(function(t){return{title:t.title,detail:t.detail,note_path:t.note_path,status:t.status,action:{type:"openNote",path:t.note_path}}})}]}}}}return k(m);})();

const __plugin = __opalnote_plugin.default || __opalnote_plugin;
const __result = typeof __plugin === "function" ? __plugin() : __plugin;
return typeof __result === "string" ? __result : JSON.stringify(__result);
})()
