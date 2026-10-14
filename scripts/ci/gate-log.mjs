// Gate check titles stay generic on the public PR; the controller log keeps the reason for operators.
export function gateErrorLine(error){return String(error?.message??error).split('\n')[0].slice(0,300);}
