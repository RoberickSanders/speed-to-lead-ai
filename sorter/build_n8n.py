import json,sys
sys.path.insert(0,'.')
QS={
 "intent":{"type":"choice","instructions":"What does this inbound med spa message (web form, SMS reply, or missed-call transcript) mainly want? Messages may use slang, typos, Spanish, or sarcasm.",
  "criteria":{"book":"wants to book / schedule a new appointment","price_question":"asks about price, cost, discounts or financing","reschedule":"wants to move, change or cancel an existing appointment","complaint":"unhappy about a result, service, wait or billing","spam":"unsolicited marketing, scam, or not a real customer","opt_out":"wants to stop receiving messages / unsubscribe"}},
 "urgency":{"type":"score","instructions":"How urgently should the spa respond?","criteria":["Low: no time pressure, spam or general info","Normal: routine request","High: wants something soon (today/tomorrow) or is upset","Critical: possible adverse reaction or medical safety issue"]},
 "asks_for_human":{"type":"yes_no","instructions":"Does the sender ask to talk to a real person, staff, or a call back from someone?"},
 "opt_out_stop":{"type":"yes_no","instructions":"Is the sender asking to stop or unsubscribe from messages, including sarcastic or Spanish phrasing (e.g. STOP, lose my number, no me manden más)?"},
 "medical_question_needs_staff":{"type":"yes_no","instructions":"Does the message ask a medical or safety question (pregnancy, medications, conditions, side effects, a reaction after treatment) that a licensed staff member must answer?"}}
body="={{ JSON.stringify({model:$env.CLASSIFIER_MODEL, state:{channel:$json.body.channel||'sms', message:$json.body.message}, questions:"+json.dumps(QS,ensure_ascii=False)+"}) }}"
code="""const a=$json.answers, i=a.intent; let route;
if(a.opt_out_stop.p_yes>=0.5||i.choice==='opt_out') route='stop_all';
else if(a.medical_question_needs_staff.p_yes>=0.5) route='staff';
else if(i.choice==='spam'&&i.confidence>=0.5) route='spam_drop';
else if(i.confidence<0.5||a.asks_for_human.p_yes>=0.5||i.choice==='complaint') route='human';
else route={book:'booking_link',price_question:'price_reply',reschedule:'reschedule_link'}[i.choice]||'human';
return [{json:{route,intent:i.choice,confidence:i.confidence,urgency:a.urgency.score,model:$json.model,usage:$json.usage,message:$('Inbound Webhook').first().json.body}}];"""
routes=['stop_all','staff','spam_drop','human','booking_link','price_reply','reschedule_link']
rules=[{"conditions":{"options":{"caseSensitive":True,"typeValidation":"strict","version":2},"conditions":[{"leftValue":"={{ $json.route }}","rightValue":r,"operator":{"type":"string","operation":"equals"}}],"combinator":"and"},"renameOutput":True,"outputKey":r} for r in routes]
nodes=[
 {"parameters":{"httpMethod":"POST","path":"speed-to-lead","responseMode":"lastNode","options":{}},"name":"Inbound Webhook","type":"n8n-nodes-base.webhook","typeVersion":2,"position":[0,300],"webhookId":"speed-to-lead-demo"},
 {"parameters":{"method":"POST","url":"={{ $env.CLASSIFIER_API_URL }}","sendHeaders":True,"headerParameters":{"parameters":[{"name":"Authorization","value":"=Bearer {{ $env.CLASSIFIER_API_KEY }}"}]},"sendBody":True,"specifyBody":"json","jsonBody":body,"options":{"timeout":5000}},"name":"Classify message","type":"n8n-nodes-base.httpRequest","typeVersion":4.2,"position":[220,300]},
 {"parameters":{"jsCode":code},"name":"Route (code)","type":"n8n-nodes-base.code","typeVersion":2,"position":[440,300]},
 {"parameters":{"rules":{"values":rules},"options":{}},"name":"Switch on route","type":"n8n-nodes-base.switch","typeVersion":3.2,"position":[660,300]}]
conn={"Inbound Webhook":{"main":[[{"node":"Classify message","type":"main","index":0}]]},"Classify message":{"main":[[{"node":"Route (code)","type":"main","index":0}]]},"Route (code)":{"main":[[{"node":"Switch on route","type":"main","index":0}]]},"Switch on route":{"main":[]}}
for k,r in enumerate(routes):
    nodes.append({"parameters":{"assignments":{"assignments":[{"id":r,"name":"action","value":r,"type":"string"}]},"options":{"includeOtherFields":True}},"name":f"TODO {r}","type":"n8n-nodes-base.set","typeVersion":3.4,"position":[900,k*120]})
    conn["Switch on route"]["main"].append([{"node":f"TODO {r}","type":"main","index":0}])
json.dump({"name":"Speed-to-lead sorter (example)","nodes":nodes,"connections":conn,"settings":{},"pinData":{}},open('../n8n/speed-to-lead-sorter.n8n.json','w'),indent=1,ensure_ascii=False)
