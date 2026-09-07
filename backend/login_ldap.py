# =========================
#  Configuration LDAP
# =========================
server_address = 'ldap://10.0.70.1'
domain = 'PROSUMA'
username_prefix = f'{domain}\\'

EMAIL_DOMAIN = 'prosuma.ci'


# =========================
#  Authentification
# =========================
def login(request):
    conn = None
    if request.method == 'POST':
        username = request.POST.get("login", "").strip()
        password = request.POST.get("password", "")

        # 1) Auth locale (comptes AdminAccount en base)
        try:
            admin_account = AdminAccount.objects.get(username=username)
            if admin_account.verify_password(password):
                request.session['username'] = username
                request.session['is_local_admin'] = True
                request.session['is_dsi'] = check_is_dsi(username)
                now = timezone.now()

                is_first_login = not UserSession.objects.filter(username=username).exists()
                user_session = UserSession.objects.create(
                    username=username,
                    login_time=now,
                    last_activity=now
                )
                request.session['session_id'] = user_session.id

                if is_first_login:
                    request.session['show_welcome_popup'] = True

                return redirect('index')
        except AdminAccount.DoesNotExist:
            pass  # pas un compte local, on essaie LDAP

        # 2) Auth LDAP
        try:
            server = Server(server_address, get_info=ALL)
            conn = Connection(server, user=username_prefix + username, password=password, authentication=NTLM)
            if conn.bind():
                request.session['username'] = username
                request.session['is_local_admin'] = False
                request.session['is_superadmin'] = check_is_superadmin(username)
                request.session['is_dsi'] = check_is_dsi(username)
                now = timezone.now()

                # Vérifier si c'est la première connexion de cet utilisateur
                is_first_login = not UserSession.objects.filter(username=username).exists()

                user_session = UserSession.objects.create(
                    username=username,
                    login_time=now,
                    last_activity=now
                )
                request.session['session_id'] = user_session.id

                # Afficher le popup de bienvenue uniquement lors de la première connexion
                if is_first_login:
                    request.session['show_welcome_popup'] = True

                return redirect('index')
            else:
                messages.error(request, "Login ou mot de passe incorrect.")
        except Exception:
            messages.error(request, "Une erreur est survenue lors de l'authentification.")
        finally:
            try:
                if conn is not None:
                    conn.unbind()
            except Exception:
                pass
    return render(request, 'my_app/login.html')

