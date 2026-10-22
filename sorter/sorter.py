"""Speed-to-lead message sorter (demo). EXAMPLE data only. One batched classification call per message.
API key comes from the environment (read by the adapter; never printed)."""
import json, time, os, statistics
from model_client import Choice, Score, Question, client
FLOOR = 0.5
Q = {
 'intent': Choice(instructions="What does this inbound med spa message (web form, SMS reply, or missed-call transcript) mainly want? Messages may use slang, typos, Spanish, or sarcasm.",
   criteria={'book':'wants to book / schedule a new appointment','price_question':'asks about price, cost, discounts or financing',
     'reschedule':'wants to move, change or cancel an existing appointment','complaint':'unhappy about a result, service, wait or billing',
     'spam':'unsolicited marketing, scam, or not a real customer','opt_out':'wants to stop receiving messages / unsubscribe'}),
 'urgency': Score(instructions="How urgently should the spa respond?",
   criteria=["Low: no time pressure, spam or general info","Normal: routine request","High: wants something soon (today/tomorrow) or is upset","Critical: possible adverse reaction or medical safety issue"]),
 'asks_for_human': Question(instructions="Does the sender ask to talk to a real person, staff, or a call back from someone?"),
 'opt_out_stop': Question(instructions="Is the sender asking to stop or unsubscribe from messages, including sarcastic or Spanish phrasing (e.g. STOP, lose my number, no me manden más)?"),
 'medical_question_needs_staff': Question(instructions="Does the message ask a medical or safety question (pregnancy, medications, conditions, side effects, a reaction after treatment) that a licensed staff member must answer?"),
}
def route(a):
    i = a['intent']
    if a['opt_out_stop'].p_yes >= 0.5 or i.choice == 'opt_out': return 'stop_all'
    if a['medical_question_needs_staff'].p_yes >= 0.5: return 'staff'
    if i.choice == 'spam' and i.confidence >= FLOOR: return 'spam_drop'
    if i.confidence < FLOOR or a['asks_for_human'].p_yes >= 0.5 or i.choice == 'complaint': return 'human'
    return {'book':'booking_link','price_question':'price_reply','reschedule':'reschedule_link'}.get(i.choice, 'human')
def classify(channel, text):
    c = client(); state = {'channel': channel, 'message': text}
    for k in range(4):
        try:
            t = time.perf_counter(); r = c.system_one(state=state, questions=Q); return r, time.perf_counter() - t
        except Exception as e:
            err = type(e).__name__; time.sleep(2 ** k)
    raise RuntimeError(err)
if __name__ == '__main__':
    data = json.load(open('testset_example.json')); out = open('results.jsonl', 'w'); lat = []; ok = 0; toks = 0
    for n, (ch, txt, exp) in enumerate(data, 1):
        r, dt = classify(ch, txt); a = r.answers; got = route(a); lat.append(dt); ok += got == exp; toks += r.usage.input_tokens
        rec = dict(id=n, channel=ch, text=txt, expected=exp, route=got, correct=got == exp, latency_s=round(dt, 3),
          model=r.model,
          usage=dict(input_tokens=r.usage.input_tokens, output_tokens=r.usage.output_tokens),
          intent=a['intent'].choice, intent_conf=round(a['intent'].confidence, 3), urgency=a['urgency'].score,
          asks_for_human=round(a['asks_for_human'].p_yes, 3), opt_out=round(a['opt_out_stop'].p_yes, 3),
          medical=round(a['medical_question_needs_staff'].p_yes, 3))
        out.write(json.dumps(rec, ensure_ascii=False) + '\n'); print(json.dumps(rec, ensure_ascii=False), flush=True)
    lat.sort()
    print(f"ACCURACY {ok}/{len(data)} = {ok/len(data):.1%}  latency median {statistics.median(lat)*1000:.0f}ms p90 {lat[int(.9*len(lat))-1]*1000:.0f}ms max {lat[-1]*1000:.0f}ms  input_tokens {toks}")
