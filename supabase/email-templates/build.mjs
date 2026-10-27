// Builds the Supabase Auth email templates (sign-in code, sign-up code, password reset, invite, email change)
// in the JAG design. Run: npx esbuild ../functions/_shared/jag-email.ts --format=esm --outfile=/tmp/jag-email.mjs && node build.mjs /tmp/jag-email.mjs
// Then paste each .html into Supabase → Authentication → Emails → Templates (subjects are in subjects.txt).
import fs from 'fs';
const E = await import(process.argv[2]);
const { shell, row, h1, lead, button, C, FONT } = E;
const codeBox = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${C.redTint}" style="background:${C.redTint};border:2px dashed ${C.red};border-radius:14px;padding:16px 26px;font-family:'Courier New',Courier,monospace;font-size:36px;line-height:40px;font-weight:bold;letter-spacing:10px;color:${C.ink}">{{ .Token }}</td></tr></table>
<div style="font-family:${FONT};font-size:13px;color:${C.muted};margin-top:10px">Vence en 1 hora · Expires in 1 hour</div></td></tr></table>`;
const english = (t, p) => `<div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:18px"><div style="font-size:16px;font-weight:800;margin:0 0 4px">${t}</div><div style="font-size:14px;color:${C.muted}">${p}</div></div>`;
const ignore = "¿No lo pidió? Puede ignorar este correo. · Didn't ask for this? You can ignore this email.";
const T = {
  'magic-link': { subject: '{{ .Token }} es su código de JAG · your JAG code', pre: '{{ .Token }} · Vence en 1 hora · Expires in 1 hour',
    body: row(h1('Su código para entrar') + lead('Escriba este código en jasonaguirregroup.company para entrar a su cuenta.') + codeBox
      + english('Your sign-in code', 'Enter the code above on jasonaguirregroup.company to sign in to your account.'), '0 32px') },
  'confirm-signup': { subject: '{{ .Token }} es su código de JAG · your JAG code', pre: '{{ .Token }} · Bienvenido a JAG · Welcome to JAG',
    body: row(h1('Bienvenido a JAG') + lead('Escriba este código en jasonaguirregroup.company para crear su cuenta. Ahí puede guardar casas, recibir avisos y hablar con su agente.') + codeBox
      + english('Welcome to JAG', 'Enter the code above on jasonaguirregroup.company to finish creating your account. Save homes, get alerts and message your agent.'), '0 32px') },
  'reauthentication': { subject: '{{ .Token }} es su código de JAG · your JAG code', pre: '{{ .Token }}',
    body: row(h1('Confirme que es usted') + lead('Escriba este código para continuar.') + codeBox + english('Confirm it\'s you', 'Enter the code above to continue.'), '0 32px') },
  'reset-password': { subject: 'Cambie su contraseña de JAG · Reset your JAG password', pre: 'Cambie su contraseña · Reset your password',
    body: row(h1('Cambie su contraseña') + lead('Toque el botón para poner una contraseña nueva. El enlace vence en 1 hora.') + button('{{ .ConfirmationURL }}', 'Poner contraseña nueva · Set a new password', { full: true })
      + english('Reset your password', 'Tap the button above to set a new password. The link expires in 1 hour.'), '0 32px') },
  'invite': { subject: 'Lo invitaron a JAG · You\'re invited to JAG', pre: 'Acepte su invitación · Accept your invitation',
    body: row(h1('Lo invitaron a JAG') + lead('Toque el botón para aceptar la invitación y entrar a su cuenta.') + button('{{ .ConfirmationURL }}', 'Aceptar invitación · Accept invitation', { full: true })
      + english('You\'re invited', 'Tap the button above to accept the invitation and sign in.'), '0 32px') },
  'change-email': { subject: 'Confirme su correo nuevo · Confirm your new email', pre: '{{ .NewEmail }}',
    body: row(h1('Confirme su correo nuevo') + lead('Toque el botón para cambiar su correo de {{ .Email }} a {{ .NewEmail }}.') + button('{{ .ConfirmationURL }}', 'Confirmar correo · Confirm email', { full: true })
      + english('Confirm your new email', 'Tap the button above to change your email from {{ .Email }} to {{ .NewEmail }}.'), '0 32px') },
};
const subj = [];
for (const [k, v] of Object.entries(T)) {
  fs.writeFileSync(k + '.html', shell({ es: true, title: v.subject, preheader: v.pre, body: v.body, footerNote: ignore }));
  subj.push(`${k}: ${v.subject}`);
}
fs.writeFileSync('subjects.txt', subj.join('\n') + '\n');
console.log(subj.join('\n'));
