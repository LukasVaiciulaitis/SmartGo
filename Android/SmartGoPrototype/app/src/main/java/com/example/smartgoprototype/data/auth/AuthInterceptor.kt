package com.example.smartgoprototype.data.auth

import okhttp3.Interceptor
import okhttp3.Response
import kotlinx.coroutines.runBlocking
import javax.inject.Inject

/**
 * Adds a Bearer token to all outbound requests.
 *
 * The cache is checked first (synchronous). runBlocking is only reached on cold start or after
 * cache expiry, where a single Amplify callback round-trip resolves quickly.
 */
class AuthInterceptor @Inject constructor(
    private val sessionProvider: SessionProvider
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()

        val token = sessionProvider.getCachedIdToken()
            ?: runBlocking { sessionProvider.getIdToken() }

        val newRequest = if (!token.isNullOrBlank()) {
            originalRequest.newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else {
            originalRequest
        }

        return chain.proceed(newRequest)
    }
}
