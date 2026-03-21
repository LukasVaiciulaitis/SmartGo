package com.example.smartgoprototype.di

import com.example.smartgoprototype.BuildConfig
import com.example.smartgoprototype.data.auth.AuthInterceptor
import com.example.smartgoprototype.data.auth.CognitoSessionProvider
import com.example.smartgoprototype.data.auth.SessionProvider
import com.example.smartgoprototype.data.remote.api.RoutesApi
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    //TODO: move this to BuildConfig
    private const val BASE_URL = "https://6az3vr0y5j.execute-api.us-east-1.amazonaws.com/prod/"

    @Provides
    @Singleton
    fun provideSessionProvider(): SessionProvider = CognitoSessionProvider()

    @Provides
    @Singleton
    fun provideAuthInterceptor(
        sessionProvider: SessionProvider
    ): AuthInterceptor = AuthInterceptor(sessionProvider)

    @Provides
    @Singleton
    fun provideOkHttpClient(
        authInterceptor: AuthInterceptor
    ): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

        return OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .addInterceptor(logging)
            .build()
    }

    @Provides
    @Singleton
    fun provideMoshi(): Moshi =
        Moshi.Builder()
            .add(KotlinJsonAdapterFactory())
            .build()

    @Provides
    @Singleton
    fun provideRetrofit(
        okHttpClient: OkHttpClient,
        moshi: Moshi
    ): Retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()

    @Provides
    @Singleton
    fun provideRoutesApi(retrofit: Retrofit): RoutesApi =
        retrofit.create(RoutesApi::class.java)
}
