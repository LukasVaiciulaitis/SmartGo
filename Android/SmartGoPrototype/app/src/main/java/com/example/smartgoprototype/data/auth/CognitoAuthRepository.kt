package com.example.smartgoprototype.data.auth

import android.util.Log
import com.amplifyframework.auth.AuthUserAttributeKey
import com.amplifyframework.auth.options.AuthSignUpOptions
import com.amplifyframework.core.Amplify
import com.example.smartgoprototype.domain.repository.AuthRepository
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import kotlin.coroutines.resume

/**
 * AuthRepository implementation backed by AWS Amplify (Cognito).
 *
 * Design notes:
 * - Exposes a small domain-friendly API (`login/register/confirmSignUp`) and returns `Result<Unit>`
 *   so ViewModels can handle success/failure without knowing Amplify's callback types.
 * - Uses `suspendCancellableCoroutine` to bridge Amplify callbacks into coroutines.
 */
class CognitoAuthRepository @Inject constructor() : AuthRepository {

    override suspend fun login(identifier: String, password: String): Result<Unit> {
        return suspendCancellableCoroutine { cont ->
            Amplify.Auth.signIn(
                identifier,
                password,
                { result ->
                    if (result.isSignedIn) {
                        cont.resume(Result.success(Unit))
                    } else {
                        // Cognito may require additional steps (MFA, password reset, etc.).
                        cont.resume(
                            Result.failure(
                                IllegalStateException("Sign-in not complete: ${result.nextStep.signInStep}")
                            )
                        )
                    }
                },
                { error ->
                    Log.e("CognitoAuthRepository", "signIn failed", error)
                    cont.resume(Result.failure(error))
                }
            )
        }
    }

    override suspend fun register(
        email: String,
        password: String
    ): Result<Unit> {
        return suspendCancellableCoroutine { cont ->
            val normalizedEmail = email.trim().lowercase()

            val options = AuthSignUpOptions.builder()
                .userAttribute(AuthUserAttributeKey.email(), normalizedEmail)
                .build()

            Amplify.Auth.signUp(
                normalizedEmail,
                password,
                options,
                { result ->
                    Log.i(
                        "CognitoAuthRepository",
                        "signUp success: isSignUpComplete=${result.isSignUpComplete}, nextStep=${result.nextStep.signUpStep}"
                    )
                    // For this prototype, the UI handles the confirmation step separately.
                    cont.resume(Result.success(Unit))
                },
                { error ->
                    Log.e("CognitoAuthRepository", "signUp failed", error)
                    cont.resume(Result.failure(error))
                }
            )
        }
    }

    override suspend fun confirmSignUp(
        email: String,
        code: String
    ): Result<Unit> {
        return suspendCancellableCoroutine { cont ->
            val normalizedEmail = email.trim().lowercase()

            Amplify.Auth.confirmSignUp(
                normalizedEmail,
                code,
                { result ->
                    if (result.isSignUpComplete) {
                        cont.resume(Result.success(Unit))
                    } else {
                        cont.resume(
                            Result.failure(
                                IllegalStateException(
                                    "Confirmation not complete. Next step: ${result.nextStep}"
                                )
                            )
                        )
                    }
                },
                { error ->
                    Log.e("CognitoAuthRepository", "confirmSignUp failed", error)
                    cont.resume(Result.failure(error))
                }
            )
        }
    }

}