package com.example.smartgoprototype.data.auth

import okhttp3.Interceptor
import okhttp3.Response
import kotlinx.coroutines.runBlocking
import javax.inject.Inject

/**
 * OkHttp interceptor that injects the current user's ID token into outbound requests.
 *
 * Important:
 * - OkHttp interceptors are not suspendable, so this prototype uses `runBlocking` to bridge into
 *   the (suspending) session provider.
 * - This is acceptable for now but can block an OkHttp thread; future implementation will
 *   use a synchronous token cache, or OkHttp's authenticator pattern with safe refresh logic.
 */
class AuthInterceptor @Inject constructor(
    private val sessionProvider: SessionProvider
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()

        // TODO: fix blocking behavior
        // `runBlocking` is used here because Interceptor.intercept() is not a suspend function.
        // The goal is to keep token lookup centralized in SessionProvider rather than duplicating
        // auth logic in every repository/API call.
        val token = runBlocking {
            sessionProvider.getIdToken()
        }

        // Only add the header when a token is available; unauthenticated endpoints can still work.
        val newRequest = if (!token.isNullOrBlank()) {
            originalRequest
                .newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else {
            originalRequest
        }

        return chain.proceed(newRequest)
    }
}
